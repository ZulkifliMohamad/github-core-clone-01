// app.ts — a standalone GitHub-compatible git forge (single process, Node stdlib only).
//
// Surfaces:
//   * Git smart HTTP  at /{owner}/{repo}.git  (upload-pack v2 + v0, receive-pack v0)
//   * REST v3         at /api/v3
//   * GraphQL v4      at /api/graphql
//   * MCP             at /mcp (JSON-RPC 2.0 Streamable HTTP)
//
// State is held in memory only. All server-created timestamps are deterministic
// (a fixed epoch plus a counter), never the wall clock, so replays are stable.
// The viewer login is fixed by the contest scenario (see VIEWER_LOGIN below).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------------------------

/** Bearer token the harness sends; empty means "no auth configured" (local smoke tests). */
const TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** The viewer login of the contest scenario (fixed seed 0x6a09e667f3bcc909). */
const VIEWER_LOGIN = 'adaiversen';
const ZERO_OID = '0000000000000000000000000000000000000000';
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const IDENTITY = 'Conformance <conformance@make.fun>';
/** Deterministic epoch for server-created commits (2023-11-14T22:13:20Z). */
const EPOCH_SEC = 1700000000;
const AGENT = 'github-core-clone/1.0.0';
const VERSION = '1.0.0';

let commitSeq = 0;
function nextTimestamp(): number {
  return EPOCH_SEC + (commitSeq += 1);
}

// ---------------------------------------------------------------------------------------------
// git object model
// ---------------------------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, message };
}

function buildCommit(tree: string, parents: string[], message: string): Buffer {
  const ts = nextTimestamp();
  const who = `${IDENTITY} ${ts} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

function parseTag(data: Buffer): { object: string; type: ObjType } {
  const blank = data.indexOf('\n\n');
  const head = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  let object = '';
  let type = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5);
  }
  if (!isOid(object)) throw new Error('tag has no valid object header');
  return { object, type: type as ObjType };
}

/** Peel a tag (possibly nested) down to the object it points at. */
function peelObject(repo: Repo, oid: string): { oid: string; type: ObjType } {
  let cur = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj) return { oid: cur, type: 'commit' };
    if (obj.type !== 'tag') return { oid: cur, type: obj.type };
    cur = parseTag(obj.data).object;
  }
  return { oid: cur, type: 'commit' };
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (off >= delta.length) throw new Error('delta size varint is truncated');
      const b = delta[off++];
      value += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOff += delta[off++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[off++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOff + copySize > base.length) throw new Error('delta copy is out of the base');
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const len = op & 0x7f;
      if (off + len > delta.length) throw new Error('delta insert is truncated');
      delta.copy(out, written, off, off + len);
      off += len;
      written += len;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface PackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA entries. */
function readPack(pack: Buffer, resolveBase: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declared = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  const raw: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let off = 12;
  for (let i = 0; i < declared; i += 1) {
    const entryOffset = off;
    let byte = pack[off];
    let size = byte & 0x0f;
    let shift = 4;
    const first = byte;
    off += 1;
    while (byte & 0x80) {
      if (off >= pack.length) throw new Error('pack entry size varint is truncated');
      byte = pack[off++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: PackEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      byte = pack[off];
      off += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[off++];
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (off + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${i} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), off);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch after inflate');
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, PackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: PackEntry): { type: ObjType; data: Buffer; oid: string } => {
    const cached = (entry as unknown as { _r?: { type: ObjType; data: Buffer; oid: string } })._r;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase(entry.baseOid!);
        if (!external) throw new Error(`ref-delta base ${entry.baseOid} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    (entry as unknown as { _r?: unknown })._r = out;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). */
function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    parts.push(writePackObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

function pktLineText(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

function pktLineRaw(data: Buffer): Buffer {
  const len = data.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

type PktItem = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' };

function parsePktLines(buf: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pkt-line header is truncated');
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) throw new Error('pkt-line length is not hex');
    if (len === 0) {
      items.push({ kind: 'flush' });
      off += 4;
    } else if (len === 1) {
      items.push({ kind: 'delim' });
      off += 4;
    } else {
      if (off + len > buf.length) throw new Error('pkt-line body is truncated');
      items.push({ kind: 'data', data: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// reachability and fetch selection
// ---------------------------------------------------------------------------------------------

/** Every object reachable from `roots` (commit -> tree + parents, tag -> target, tree -> entries). */
function collectReachable(repo: Repo, roots: Iterable<string>, allowMissing = false): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isOid(r)) queue.push(r);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) {
      if (allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') queue.push(e.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (following parents, peeling tags). */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const start = peelObject(repo, tip);
  if (start.type !== 'commit') return false;
  const seen = new Set<string>();
  const queue = [start.oid];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}

/**
 * Objects a v2/v0 fetch must send for `wants`, minus what the client already holds (`haves`),
 * honoring `deepen` (max commit generations from a want, generation 0 = the want itself).
 * Returns the pack objects plus shallow/unshallow boundary lines.
 */
function selectFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  requestedShallow: string[],
  deepen: number | null,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  // What the client already holds: the closure of its haves, but never past its shallow
  // boundaries — a client holding a shallow tip does NOT hold that tip's parents.
  const shallowSet = new Set(requestedShallow);
  const held = new Set<string>();
  {
    const seen = new Set<string>();
    const stack: string[] = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      held.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        if (!shallowSet.has(oid)) for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) {
          if (e.mode !== '160000') stack.push(e.oid);
        }
      }
    }
  }
  // BFS generations from the wants.
  const gen = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const w of wants) {
    const peeled = peelObject(repo, w);
    if (peeled.type === 'commit' && !gen.has(peeled.oid)) {
      gen.set(peeled.oid, 0);
      queue.push([peeled.oid, 0]);
    }
  }
  const included = new Set<string>();
  const boundary = new Set<string>();
  let qi = 0;
  while (qi < queue.length) {
    const [oid, g] = queue[qi++];
    if (deepen !== null && g >= deepen) continue;
    if (included.has(oid)) continue;
    included.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    if (deepen !== null && g === deepen - 1 && c.parents.length > 0) boundary.add(oid);
    for (const p of c.parents) {
      if (!gen.has(p)) {
        gen.set(p, g + 1);
        queue.push([p, g + 1]);
      }
    }
  }
  // Objects for the pack: the depth-limited closure of the included commits — a commit's tree
  // (fully) plus only those parents that are themselves included. Raw want oids (e.g. an
  // annotated tag) are roots too, so the tag object itself is sent, not just its target.
  const wanted = new Set<string>();
  const seenObj = new Set<string>();
  const stack: string[] = [...included, ...wants.filter((w) => isOid(w))];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seenObj.has(oid)) continue;
    seenObj.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    wanted.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) if (included.has(p)) stack.push(p);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') stack.push(e.oid);
      }
    }
  }
  for (const h of held) wanted.delete(h);
  const objects: GitObject[] = [];
  // Deterministic order: included commits first (by generation, then oid), then the rest by oid.
  const ordered: string[] = [];
  const commitOids = [...included].filter((o) => wanted.has(o));
  commitOids.sort((a, b) => (gen.get(a)! - gen.get(b)!) || (a < b ? -1 : 1));
  for (const o of commitOids) ordered.push(o);
  const rest = [...wanted].filter((o) => !included.has(o)).sort();
  for (const o of rest) ordered.push(o);
  for (const o of ordered) {
    const obj = repo.objects.get(o);
    if (obj) objects.push(obj);
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const b of boundary) shallow.push(b);
  const sentOids = new Set<string>();
  for (const o of ordered) sentOids.add(o);
  for (const s of requestedShallow) {
    if (shallow.includes(s) || unshallow.includes(s)) continue;
    const obj = repo.objects.get(s);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    const allParentsSent = parents.length === 0 || parents.every((p) => sentOids.has(p));
    const anyParentSent = parents.some((p) => sentOids.has(p));
    if (sentOids.has(s)) {
      if (allParentsSent) unshallow.push(s);
      else shallow.push(s);
    } else if (held.has(s)) {
      // Client still holds this boundary: unshallow only once a parent arrives.
      if (anyParentSent) unshallow.push(s);
      else shallow.push(s);
    }
  }
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------------------------

interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Array<{ id: number; body: string }>;
  seq: number;
}

interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  baseTree: string;
  seq: number;
}

interface Repo {
  owner: string;
  name: string;
  id: number;
  description: string;
  priv: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  prs: PullRequest[];
  labels: Map<string, { name: string; color: string }>;
  nextIssue: number;
  nextPr: number;
  nextComment: number;
  seq: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextGlobalId = 1;
let reqCounter = 0;
let globalSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function createRepo(owner: string, name: string, priv: boolean, description: string): Repo {
  const repo: Repo = {
    owner,
    name,
    id: nextRepoId++,
    description: description ?? '',
    priv: !!priv,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    issues: [],
    prs: [],
    labels: new Map(),
    nextIssue: 1,
    nextPr: 1,
    nextComment: 1,
    seq: ++globalSeq,
  };
  // The empty tree, so an unborn repo still has a valid tree object.
  repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
  repos.set(repoKey(owner, name), repo);
  return repo;
}

function listRepos(): Repo[] {
  return [...repos.values()].sort((a, b) => a.seq - b.seq);
}

/** Resolve a branch name, full ref, or oid to a commit oid (or null). */
function resolveRef(repo: Repo, ref: string): string | null {
  if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
  if (ref.startsWith('refs/')) {
    const oid = repo.refs.get(ref);
    return oid ?? null;
  }
  const oid = repo.refs.get(`refs/heads/${ref}`);
  if (oid) return oid;
  const tagOid = repo.refs.get(`refs/tags/${ref}`);
  if (tagOid) return tagOid;
  return null;
}

/** Flatten a tree into path -> {oid, mode}. */
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
}

function treeFiles(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return out;
  flattenTree(repo, parseCommit(obj.data).tree, '', out);
  return out;
}

/** Build nested trees from a flat file map; stores every tree object. Returns the root tree oid. */
function buildTreesFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, f] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], f);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, f] of node.files) entries.push({ mode: f.mode, name, oid: f.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Commits reachable from `tip`, newest first (preorder DFS, first parent first). */
function listCommits(repo: Repo, tip: string): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    out.push({ sha: oid, message: c.message });
    for (let i = c.parents.length - 1; i >= 0; i -= 1) stack.push(c.parents[i]);
  }
  return out;
}

/** Diff two flat file maps. */
function diffFiles(
  before: Map<string, { oid: string; mode: string }>,
  after: Map<string, { oid: string; mode: string }>,
): Array<{ path: string; status: 'added' | 'removed' | 'modified'; beforeOid: string | null; afterOid: string | null }> {
  const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; beforeOid: string | null; afterOid: string | null }> = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const p of [...paths].sort()) {
    const b = before.get(p);
    const a = after.get(p);
    if (b && !a) out.push({ path: p, status: 'removed', beforeOid: b.oid, afterOid: null });
    else if (!b && a) out.push({ path: p, status: 'added', beforeOid: null, afterOid: a.oid });
    else if (b && a && b.oid !== a.oid) out.push({ path: p, status: 'modified', beforeOid: b.oid, afterOid: a.oid });
  }
  return out;
}

/** True when merging `headTip` into `baseTip` would conflict, given the merge base tree. */
function mergeConflicts(repo: Repo, baseTreeOid: string, baseTip: string, headTip: string): boolean {
  const baseFiles = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, baseTreeOid, '', baseFiles);
  const curBase = treeFiles(repo, baseTip);
  const head = treeFiles(repo, headTip);
  const paths = new Set([...baseFiles.keys(), ...curBase.keys(), ...head.keys()]);
  for (const p of paths) {
    const b = baseFiles.get(p)?.oid ?? null;
    const c = curBase.get(p)?.oid ?? null;
    const h = head.get(p)?.oid ?? null;
    const changedHead = h !== b;
    const changedBase = c !== b;
    if (changedHead && changedBase && h !== c) return true;
  }
  return false;
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const text = buf.toString('utf8');
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------------------------

function nextRequestId(): string {
  reqCounter += 1;
  return `req-${reqCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    'content-length': Buffer.byteLength(text),
    ...(extra ?? {}),
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': body.length,
  });
  res.end(body);
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${TOKEN}` || h === `token ${TOKEN}`;
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; totalPages: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages, pageNum, perPage };
}

function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, pageNum: number, totalPages: number, perPage: number): string | null {
  if (totalPages <= 1) return null;
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${path}`;
  const mk = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${base}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (pageNum < totalPages) parts.push(`${mk(pageNum + 1)}; rel="next"`);
  parts.push(`${mk(totalPages)}; rel="last"`);
  if (pageNum > 1) parts.push(`${mk(1)}; rel="first"`);
  return parts.join(', ');
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.priv,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_pull_requests: true,
    fork: false,
    archived: false,
    disabled: false,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    pushed_at: '2025-01-01T00:00:00Z',
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    comments: issue.comments.length,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function sortIssues(issues: Issue[], query: URLSearchParams): Issue[] {
  const list = [...issues];
  const dir = query.get('direction') ?? 'desc';
  const sort = query.get('sort') ?? 'created';
  if (sort === 'created') {
    list.sort((a, b) => (dir === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  return list;
}

// ---------------------------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------------------------

async function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams, body: Buffer): Promise<void> {
  const path = `/api/v3/${segments.join('/')}`;
  const method = req.method ?? 'GET';

  // Root and meta stay open; everything else needs the bearer token.
  if (!(segments.length === 0 || (segments.length === 1 && segments[0] === 'meta'))) {
    if (!authed(req)) {
      jsonError(res, 401, 'Requires authentication');
      return;
    }
  }

  if (segments.length === 0) {
    if (method !== 'GET') {
      jsonError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') {
      jsonError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, { installed_version: VERSION });
    return;
  }

  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') {
      jsonError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, { login: VIEWER_LOGIN, id: 1000, type: 'User', name: 'ada iversen', email: `${VIEWER_LOGIN}@example.invalid` });
    return;
  }

  // POST /user/repos — create a repository owned by the viewer.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        jsonError(res, 400, 'Invalid JSON');
        return;
      }
      const b = (parsed.value ?? {}) as Record<string, unknown>;
      const name = String(b.name ?? '');
      if (name === '') {
        jsonError(res, 422, 'name is required');
        return;
      }
      if (getRepo(VIEWER_LOGIN, name)) {
        jsonError(res, 422, `Repository ${VIEWER_LOGIN}/${name} already exists`);
        return;
      }
      const repo = createRepo(VIEWER_LOGIN, name, b.private === true, typeof b.description === 'string' ? b.description : '');
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const { page, totalPages, pageNum, perPage } = paginate(listRepos(), query);
      const link = linkHeader(req, path, query, pageNum, totalPages, perPage);
      sendJson(res, 200, page.map(repoJson), link ? { link } : undefined);
      return;
    }
    jsonError(res, 404, 'Not Found');
    return;
  }

  // /repos/{owner}/{repo}[...]
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1];
    const name = segments[2];
    const repo = getRepo(owner, name);
    const rest = segments.slice(3);

    if (!repo) {
      jsonError(res, 404, 'Not Found');
      return;
    }

    // GET /repos/{o}/{r} | PATCH | DELETE
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          jsonError(res, 400, 'Invalid JSON');
          return;
        }
        const b = (parsed.value ?? {}) as Record<string, unknown>;
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.default_branch === 'string' && b.default_branch !== '') repo.defaultBranch = b.default_branch;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      jsonError(res, 404, 'Not Found');
      return;
    }

    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          jsonError(res, 400, 'Invalid JSON');
          return;
        }
        const b = (parsed.value ?? {}) as Record<string, unknown>;
        const ref = String(b.ref ?? '');
        const sha = String(b.sha ?? '');
        if (ref === '' || !isOid(sha)) {
          jsonError(res, 422, 'ref and sha are required');
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha } });
        return;
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = rest.slice(2).join('/');
        const oid = repo.refs.get(ref);
        if (!oid) {
          jsonError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { ref, object: { sha: oid } });
        return;
      }
      jsonError(res, 404, 'Not Found');
      return;
    }

    // branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const out = [...repo.refs.entries()]
          .filter(([r]) => r.startsWith('refs/heads/'))
          .map(([r, oid]) => ({ name: r.slice('refs/heads/'.length), commit: { sha: oid } }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(res, 200, out);
        return;
      }
      if (method === 'GET' && rest.length >= 2) {
        const branch = rest.slice(1).join('/');
        const oid = repo.refs.get(`refs/heads/${branch}`);
        if (!oid) {
          jsonError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { name: branch, commit: { sha: oid } });
        return;
      }
      jsonError(res, 404, 'Not Found');
      return;
    }

    // commits
    if (rest[0] === 'commits') {
      if (method === 'GET' && rest.length === 1) {
        const shaParam = query.get('sha') ?? repo.defaultBranch;
        const tip = resolveRef(repo, shaParam);
        if (!tip) {
          sendJson(res, 200, []);
          return;
        }
        const list = listCommits(repo, tip).map((c) => ({
          sha: c.sha,
          commit: {
            message: c.message,
            author: { name: 'Conformance', email: 'conformance@make.fun' },
            committer: { name: 'Conformance', email: 'conformance@make.fun' },
          },
        }));
        sendJson(res, 200, list);
        return;
      }
      jsonError(res, 404, 'Not Found');
      return;
    }

    // contents
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'PUT') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          jsonError(res, 400, 'Invalid JSON');
          return;
        }
        const b = (parsed.value ?? {}) as Record<string, unknown>;
        const message = typeof b.message === 'string' ? b.message : 'update';
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
        const shaParam = typeof b.sha === 'string' ? b.sha : null;
        let bytes: Buffer;
        try {
          bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        } catch {
          jsonError(res, 422, 'content is not valid base64');
          return;
        }
        const refName = `refs/heads/${branch}`;
        let tip = repo.refs.get(refName);
        if (tip === undefined && branch !== repo.defaultBranch) {
          // A named branch that does not exist starts at the default tip.
          tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        }
        const files = tip ? treeFiles(repo, tip) : new Map<string, { oid: string; mode: string }>();
        const existing = files.get(filePath);
        if (shaParam !== null) {
          if (!existing || existing.oid !== shaParam) {
            jsonError(res, 409, 'sha does not match the current blob');
            return;
          }
        }
        const isCreate = !existing;
        const blobOid = storeObject(repo, 'blob', bytes);
        files.set(filePath, { oid: blobOid, mode: '100644' });
        const rootTree = buildTreesFromFiles(repo, files);
        const parents = tip ? [tip] : [];
        const commitOid = storeObject(repo, 'commit', buildCommit(rootTree, parents, message));
        repo.refs.set(refName, commitOid);
        sendJson(res, isCreate ? 201 : 200, {
          content: {
            name: filePath.split('/').pop() ?? '',
            path: filePath,
            sha: blobOid,
            size: bytes.length,
            encoding: 'base64',
            content: bytes.toString('base64'),
          },
          commit: { sha: commitOid, message },
        });
        return;
      }
      if (method === 'GET') {
        const refParam = query.get('ref') ?? repo.defaultBranch;
        const tip = resolveRef(repo, refParam);
        if (!tip) {
          jsonError(res, 404, 'Not Found');
          return;
        }
        const files = treeFiles(repo, tip);
        if (filePath === '') {
          // Root directory listing.
          const top = new Map<string, { oid: string; mode: string }>();
          const obj = repo.objects.get(parseCommit(repo.objects.get(tip)!.data).tree);
          if (obj && obj.type === 'tree') {
            for (const e of parseTree(obj.data)) top.set(e.name, { oid: e.oid, mode: e.mode });
          }
          const out = [...top.entries()].map(([name, f]) => ({
            type: f.mode === '40000' ? 'dir' : 'file',
            name,
            path: name,
            sha: f.oid,
            size: f.mode === '40000' ? 0 : (repo.objects.get(f.oid)?.data.length ?? 0),
          }));
          sendJson(res, 200, out);
          return;
        }
        const file = files.get(filePath);
        if (file) {
          const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file',
            name: filePath.split('/').pop() ?? '',
            path: filePath,
            sha: file.oid,
            size: data.length,
            encoding: 'base64',
            content: data.toString('base64'),
          });
          return;
        }
        // Directory?
        const prefix = `${filePath}/`;
        const children = new Map<string, { oid: string; mode: string }>();
        for (const [p, f] of files) {
          if (p.startsWith(prefix)) {
            const restPath = p.slice(prefix.length);
            const first = restPath.split('/')[0];
            if (!restPath.includes('/')) children.set(first, f);
            else if (!children.has(first)) {
              // Find the directory tree oid by walking the tree.
              children.set(first, { oid: dirOid(repo, tip, `${filePath}/${first}`) ?? '', mode: '40000' });
            }
          }
        }
        if (children.size > 0) {
          const out = [...children.entries()].map(([name, f]) => ({
            type: f.mode === '40000' ? 'dir' : 'file',
            name,
            path: `${filePath}/${name}`,
            sha: f.oid,
            size: f.mode === '40000' ? 0 : (repo.objects.get(f.oid)?.data.length ?? 0),
          }));
          sendJson(res, 200, out);
          return;
        }
        jsonError(res, 404, 'Not Found');
        return;
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          jsonError(res, 400, 'Invalid JSON');
          return;
        }
        const b = (parsed.value ?? {}) as Record<string, unknown>;
        const message = typeof b.message === 'string' ? b.message : 'delete';
        const shaParam = typeof b.sha === 'string' ? b.sha : null;
        const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        if (!tip) {
          jsonError(res, 404, 'Not Found');
          return;
        }
        const files = treeFiles(repo, tip);
        const existing = files.get(filePath);
        if (!existing) {
          jsonError(res, 404, 'Not Found');
          return;
        }
        if (shaParam !== null && existing.oid !== shaParam) {
          jsonError(res, 409, 'sha does not match the current blob');
          return;
        }
        files.delete(filePath);
        const rootTree = buildTreesFromFiles(repo, files);
        const commitOid = storeObject(repo, 'commit', buildCommit(rootTree, [tip], message));
        repo.refs.set(refName, commitOid);
        sendJson(res, 200, { commit: { sha: commitOid, message } });
        return;
      }
      jsonError(res, 404, 'Not Found');
      return;
    }

    // labels
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          jsonError(res, 400, 'Invalid JSON');
          return;
        }
        const b = (parsed.value ?? {}) as Record<string, unknown>;
        const name = String(b.name ?? '');
        const color = typeof b.color === 'string' ? b.color : '000000';
        if (name === '') {
          jsonError(res, 422, 'name is required');
          return;
        }
        repo.labels.set(name, { name, color });
        sendJson(res, 201, { name, color });
        return;
      }
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()]);
        return;
      }
      jsonError(res, 404, 'Not Found');
      return;
    }

    // issues
    if (rest[0] === 'issues') {
      if (method === 'POST' && rest.length === 1) {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          jsonError(res, 400, 'Invalid JSON');
          return;
        }
        const b = (parsed.value ?? {}) as Record<string, unknown>;
        const title = typeof b.title === 'string' ? b.title : '';
        if (title === '') {
          jsonError(res, 422, 'title is required');
          return;
        }
        const rawLabels: unknown[] = Array.isArray(b.labels) ? b.labels : [];
        const labelNames: string[] = [];
        for (const l of rawLabels) {
          const nm = typeof l === 'string' ? l : (l as Record<string, unknown>)?.name;
          if (typeof nm === 'string') {
            if (!repo.labels.has(nm)) {
              jsonError(res, 422, `Label ${nm} does not exist`);
              return;
            }
            labelNames.push(nm);
          }
        }
        const issue: Issue = {
          number: repo.nextIssue++,
          id: nextGlobalId++,
          title,
          body: typeof b.body === 'string' ? b.body : '',
          state: 'open',
          labels: labelNames,
          comments: [],
          seq: ++globalSeq,
        };
        repo.issues.push(issue);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      if (method === 'GET' && rest.length === 1) {
        let list = sortIssues(repo.issues, query);
        const state = query.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((i) => i.state === state);
        const { page } = paginate(list, query);
        sendJson(res, 200, page.map((i) => issueJson(repo, i)));
        return;
      }
      if (rest.length >= 2) {
        const num = Number(rest[1]);
        const issue = repo.issues.find((i) => i.number === num);
        if (!issue) {
          jsonError(res, 404, 'Not Found');
          return;
        }
        if (rest.length === 2) {
          if (method === 'GET') {
            sendJson(res, 200, issueJson(repo, issue));
            return;
          }
          if (method === 'PATCH') {
            const parsed = parseJsonBody(body);
            if (!parsed.ok) {
              jsonError(res, 400, 'Invalid JSON');
              return;
            }
            const b = (parsed.value ?? {}) as Record<string, unknown>;
            if (typeof b.title === 'string') issue.title = b.title;
            if (typeof b.body === 'string') issue.body = b.body;
            if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
            sendJson(res, 200, issueJson(repo, issue));
            return;
          }
          jsonError(res, 404, 'Not Found');
          return;
        }
        if (rest[2] === 'comments') {
          if (method === 'POST' && rest.length === 3) {
            const parsed = parseJsonBody(body);
            if (!parsed.ok) {
              jsonError(res, 400, 'Invalid JSON');
              return;
            }
            const b = (parsed.value ?? {}) as Record<string, unknown>;
            const comment = { id: repo.nextComment++, body: typeof b.body === 'string' ? b.body : '' };
            issue.comments.push(comment);
            sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: 1000 } });
            return;
          }
          if (method === 'GET' && rest.length === 3) {
            sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER_LOGIN, id: 1000 } })));
            return;
          }
          jsonError(res, 404, 'Not Found');
          return;
        }
        jsonError(res, 404, 'Not Found');
        return;
      }
      jsonError(res, 404, 'Not Found');
      return;
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (method === 'POST' && rest.length === 1) {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          jsonError(res, 400, 'Invalid JSON');
          return;
        }
        const b = (parsed.value ?? {}) as Record<string, unknown>;
        const title = typeof b.title === 'string' ? b.title : '';
        const headRef = typeof b.head === 'string' ? b.head : '';
        const baseRef = typeof b.base === 'string' ? b.base : repo.defaultBranch;
        if (title === '' || headRef === '') {
          jsonError(res, 422, 'title and head are required');
          return;
        }
        const headSha = resolveRef(repo, headRef);
        const baseSha = resolveRef(repo, baseRef);
        if (!headSha || !baseSha) {
          jsonError(res, 422, 'head or base ref does not exist');
          return;
        }
        const dup = repo.prs.find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
        if (dup) {
          jsonError(res, 422, 'A pull request already exists for this head and base');
          return;
        }
        const baseTree = parseCommit(repo.objects.get(baseSha)!.data).tree;
        const pr: PullRequest = {
          number: repo.nextPr++,
          id: nextGlobalId++,
          title,
          body: typeof b.body === 'string' ? b.body : '',
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          headRef,
          baseRef,
          headSha,
          baseSha,
          baseTree,
          seq: ++globalSeq,
        };
        repo.prs.push(pr);
        sendJson(res, 201, prJson(repo, pr));
        return;
      }
      if (method === 'GET' && rest.length === 1) {
        const state = query.get('state') ?? 'open';
        let list = [...repo.prs].sort((a, b) => b.seq - a.seq);
        if (state !== 'all') list = list.filter((p) => p.state === state);
        const { page } = paginate(list, query);
        sendJson(res, 200, page.map((p) => prJson(repo, p)));
        return;
      }
      if (rest.length >= 2) {
        const num = Number(rest[1]);
        const pr = repo.prs.find((p) => p.number === num);
        if (!pr) {
          jsonError(res, 404, 'Not Found');
          return;
        }
        if (rest.length === 2) {
          if (method === 'GET') {
            sendJson(res, 200, prJson(repo, pr));
            return;
          }
          jsonError(res, 404, 'Not Found');
          return;
        }
        if (rest[2] === 'files' && method === 'GET') {
          const before = new Map<string, { oid: string; mode: string }>();
          flattenTree(repo, pr.baseTree, '', before);
          const after = treeFiles(repo, pr.headSha);
          const diffs = diffFiles(before, after);
          const out = diffs.map((d) => {
            let additions = 0;
            let deletions = 0;
            if (d.status === 'added' && d.afterOid) additions = countLines(repo.objects.get(d.afterOid)?.data ?? Buffer.alloc(0));
            else if (d.status === 'removed' && d.beforeOid) deletions = countLines(repo.objects.get(d.beforeOid)?.data ?? Buffer.alloc(0));
            else {
              additions = countLines(repo.objects.get(d.afterOid ?? '')?.data ?? Buffer.alloc(0));
              deletions = countLines(repo.objects.get(d.beforeOid ?? '')?.data ?? Buffer.alloc(0));
            }
            return {
              filename: d.path,
              status: d.status === 'modified' ? 'modified' : d.status,
              additions,
              deletions,
              changes: additions + deletions,
            };
          });
          sendJson(res, 200, out);
          return;
        }
        if (rest[2] === 'merge' && method === 'PUT') {
          if (pr.state !== 'open') {
            jsonError(res, 405, 'Pull request is not open');
            return;
          }
          const baseTip = resolveRef(repo, pr.baseRef);
          const headTip = resolveRef(repo, pr.headRef);
          if (!baseTip || !headTip) {
            jsonError(res, 404, 'Not Found');
            return;
          }
          if (mergeConflicts(repo, pr.baseTree, baseTip, headTip)) {
            jsonError(res, 405, 'Merge conflict');
            return;
          }
          const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
          const squashOid = storeObject(repo, 'commit', buildCommit(headTree, [baseTip], pr.title));
          repo.refs.set(`refs/heads/${pr.baseRef}`, squashOid);
          pr.state = 'closed';
          pr.merged = true;
          pr.mergedAt = '2025-01-01T00:00:00Z';
          pr.mergeCommitSha = squashOid;
          sendJson(res, 200, { sha: squashOid, merged: true, message: pr.title });
          return;
        }
        jsonError(res, 404, 'Not Found');
        return;
      }
      jsonError(res, 404, 'Not Found');
      return;
    }

    jsonError(res, 404, 'Not Found');
    return;
  }

  jsonError(res, 404, 'Not Found');
}

/** Resolve the tree oid of a directory `dirPath` at commit `tip` (or null). */
function dirOid(repo: Repo, tip: string, dirPath: string): string | null {
  const obj = repo.objects.get(tip);
  if (!obj || obj.type !== 'commit') return null;
  let treeOid = parseCommit(obj.data).tree;
  for (const part of dirPath.split('/')) {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === part);
    if (!entry || entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function uploadPackV0Advertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLineText('# service=git-upload-pack\n')];
  const refs = sortedRefs(repo);
  const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k multi_ack thin-pack ofs-delta shallow agent=${AGENT}`;
  if (refs.length === 0) {
    parts.push(pktLineText(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    let first = true;
    if (tip) {
      parts.push(pktLineText(`${tip} HEAD\0${caps}\n`));
      first = false;
    }
    for (const [ref, oid] of refs) {
      if (first) {
        parts.push(pktLineText(`${oid} ${ref}\0${caps}\n`));
        first = false;
      } else {
        parts.push(pktLineText(`${oid} ${ref}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function receivePackAdvertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLineText('# service=git-receive-pack\n')];
  const refs = sortedRefs(repo);
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  if (refs.length === 0) {
    parts.push(pktLineText(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const [ref, oid] of refs) {
      if (first) {
        parts.push(pktLineText(`${oid} ${ref}\0${caps}\n`));
        first = false;
      } else {
        parts.push(pktLineText(`${oid} ${ref}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function uploadPackV2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLineText('version 2\n'),
    pktLineText(`agent=${AGENT}\n`),
    pktLineText('ls-refs=unborn\n'),
    pktLineText('fetch=shallow wait-for-done filter\n'),
    pktLineText('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

/** Sideband band-1 packets carrying `data`, each pkt-line <= 65520 bytes. */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515; // 65520 - 4 (length) - 1 (band byte)
  for (let off = 0; off < data.length; off += CHUNK) {
    const slice = data.subarray(off, Math.min(data.length, off + CHUNK));
    out.push(pktLineRaw(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (data.length === 0) out.push(pktLineRaw(Buffer.from([1])));
  return out;
}

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  const parts: Buffer[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip && matches('HEAD')) {
    const sym = wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    parts.push(pktLineText(`${tip} HEAD${sym}\n`));
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let extra = '';
    if (wantPeel) {
      const peeled = peelObject(repo, oid);
      if (peeled.oid !== oid) extra += ` peeled:${peeled.oid}`;
    }
    parts.push(pktLineText(`${oid} ${ref}${extra}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV2(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowArgs: string[] = [];
  let deepen: number | null = null;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallowArgs.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) {
      const n = Number(a.slice(7).trim());
      if (Number.isFinite(n) && n > 0) deepen = n;
    }
  }
  const { objects, shallow, unshallow } = selectFetch(repo, wants, haves, shallowArgs, deepen);
  const pack = writePack(objects);
  const parts: Buffer[] = [pktLineText('acknowledgments\n'), pktLineText('NAK\n'), PKT_DELIM];
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLineText('shallow-info\n'));
    for (const s of shallow) parts.push(pktLineText(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pktLineText(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLineText('packfile\n'));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowArgs: string[] = [];
  let deepen: number | null = null;
  for (const a of args) {
    const first = a.split(' ')[0];
    if (first === 'want') wants.push(a.slice(5).split(' ')[0]);
    else if (first === 'have') haves.push(a.slice(5).trim());
    else if (first === 'shallow') shallowArgs.push(a.slice(8).trim());
    else if (first === 'deepen') {
      const n = Number(a.slice(7).trim());
      if (Number.isFinite(n) && n > 0) deepen = n;
    }
  }
  const { objects, shallow, unshallow } = selectFetch(repo, wants, haves, shallowArgs, deepen);
  const pack = writePack(objects);
  const parts: Buffer[] = [pktLineText('NAK\n')];
  for (const s of shallow) parts.push(pktLineText(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pktLineText(`unshallow ${s}\n`));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleGitUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): Promise<void> {
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  let items: PktItem[];
  try {
    items = parsePktLines(body);
  } catch {
    // A malformed body must not take the server down; answer 200 with an empty pack section.
    sendBuffer(res, 200, Buffer.concat([pktLineText('acknowledgments\n'), pktLineText('NAK\n'), PKT_DELIM, pktLineText('packfile\n'), ...sidebandPackets(writePack([])), PKT_FLUSH]), 'application/x-git-upload-pack-result');
    return;
  }
  if (!isV2) {
    const args: string[] = [];
    for (const it of items) {
      if (it.kind === 'flush') break;
      if (it.kind === 'data') args.push(it.data.toString('utf8').trim());
    }
    // Second section (haves + done) follows the first flush.
    let seenFlush = false;
    for (const it of items) {
      if (it.kind === 'flush') {
        seenFlush = true;
        continue;
      }
      if (seenFlush && it.kind === 'data') args.push(it.data.toString('utf8').trim());
    }
    sendBuffer(res, 200, handleFetchV0(repo, args), 'application/x-git-upload-pack-result');
    return;
  }
  // v2: first data line is the command; argument lines run until the flush pkt-line.
  // (A delim pkt-line separates the command block from the arguments; it is skipped.)
  let command = '';
  const args: string[] = [];
  for (const it of items) {
    if (it.kind === 'data') {
      const text = it.data.toString('utf8');
      if (command === '') command = text.trim();
      else args.push(text.trim());
    } else if (it.kind === 'flush') {
      break;
    }
  }
  if (command === 'command=ls-refs') {
    sendBuffer(res, 200, handleLsRefs(repo, args), 'application/x-git-upload-pack-result');
    return;
  }
  if (command === 'command=fetch') {
    sendBuffer(res, 200, handleFetchV2(repo, args), 'application/x-git-upload-pack-result');
    return;
  }
  // Unknown v2 command: answer an empty fetch-style response rather than crashing.
  sendBuffer(res, 200, Buffer.concat([pktLineText('acknowledgments\n'), pktLineText('NAK\n'), PKT_DELIM, pktLineText('packfile\n'), ...sidebandPackets(writePack([])), PKT_FLUSH]), 'application/x-git-upload-pack-result');
}

async function handleGitReceivePack(_req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): Promise<void> {
  const results: string[] = [];
  let unpackOk = true;
  let unpackError = '';
  const commands: Array<{ old: string; next: string; ref: string }> = [];
  let packStart = body.length;
  // Walk the pkt-line command section only, stopping at the first flush pkt-line.
  // Everything after it is raw pack bytes and must not be parsed as pkt-lines.
  try {
    let p = 0;
    while (p + 4 <= body.length) {
      const lenText = body.subarray(p, p + 4).toString('ascii');
      const len = parseInt(lenText, 16);
      if (Number.isNaN(len) || len < 0) break;
      if (len === 0) {
        p += 4;
        break;
      }
      if (len === 1) {
        p += 4;
        continue;
      }
      if (p + len > body.length) break;
      const text = body.subarray(p + 4, p + len).toString('utf8');
      const nul = text.indexOf('\0');
      const line = (nul >= 0 ? text.slice(0, nul) : text).trim();
      const parts = line.split(' ');
      if (parts.length >= 3) commands.push({ old: parts[0], next: parts[1], ref: parts[2] });
      p += len;
    }
    packStart = p;
  } catch {
    packStart = body.length;
  }
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackError = (err as Error).message;
    }
  }
  if (unpackOk) {
    results.push('unpack ok');
  } else {
    results.push(`unpack error ${unpackError}`);
  }
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.next === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push(`ng ${cmd.ref} remote ref does not exist`);
        } else if (cmd.old !== ZERO_OID && cmd.old !== current) {
          results.push(`ng ${cmd.ref} non-fast-forward`);
        } else {
          repo.refs.delete(cmd.ref);
          results.push(`ok ${cmd.ref}`);
        }
        continue;
      }
      if (!repo.objects.has(cmd.next)) {
        results.push(`ng ${cmd.ref} object is missing`);
        continue;
      }
      if (current === undefined) {
        if (cmd.old !== ZERO_OID) {
          results.push(`ng ${cmd.ref} non-fast-forward`);
          continue;
        }
        repo.refs.set(cmd.ref, cmd.next);
        results.push(`ok ${cmd.ref}`);
        continue;
      }
      if (cmd.old !== current) {
        results.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
      if (!isAncestor(repo, current, cmd.next)) {
        results.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.next);
      results.push(`ok ${cmd.ref}`);
    }
  } else {
    for (const cmd of commands) results.push(`ng ${cmd.ref} unpack failed`);
  }
  const parts: Buffer[] = [];
  for (const line of results) parts.push(pktLineRaw(Buffer.concat([Buffer.from([1]), Buffer.from(`${line}\n`, 'utf8')])));
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

async function handleGit(req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams, body: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  // /{owner}/{repo}.git/info/refs  |  /{owner}/{repo}.git/git-upload-pack  |  .../git-receive-pack
  if (segments.length < 2 || !segments[1].endsWith('.git')) {
    jsonError(res, 404, 'Not Found');
    return;
  }
  const owner = segments[0];
  const name = segments[1].slice(0, -'.git'.length);
  const repo = getRepo(owner, name);
  if (!repo) {
    jsonError(res, 404, 'Not Found');
    return;
  }
  const tail = segments.slice(2);
  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (isV2) sendBuffer(res, 200, uploadPackV2Advertisement(), 'application/x-git-upload-pack-advertisement');
      else sendBuffer(res, 200, uploadPackV0Advertisement(repo), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, receivePackAdvertisement(repo), 'application/x-git-receive-pack-advertisement');
      return;
    }
    jsonError(res, 404, 'Not Found');
    return;
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    await handleGitUploadPack(req, res, repo, body);
    return;
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    await handleGitReceivePack(req, res, repo, body);
    return;
  }
  jsonError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// GraphQL v4 (small hand-written parser + executor for the contest's documents)
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<[string, GqlValue]> }
  | { kind: 'var'; name: string };

interface GqlField {
  alias: string | null;
  name: string;
  args: Array<[string, GqlValue]>;
  selections: GqlSelection[] | null;
}

type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'inline'; typeName: string | null; selections: GqlSelection[] };

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: Array<{ name: string; defaultValue: GqlValue | null }>;
  selections: GqlSelection[];
}

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():[]!=@'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_.\-+]/.test(src[j])) j += 1;
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const t = this.tokens[this.pos];
    this.pos += 1;
    return t;
  }

  private expect(t: string): void {
    if (this.next() !== t) throw new Error(`expected ${t} in GraphQL document`);
  }

  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): GqlOperation {
    let type: 'query' | 'mutation' = 'query';
    const tok = this.peek();
    if (tok === 'query' || tok === 'mutation') {
      type = this.next() as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (this.peek() !== undefined && this.peek() !== '{' && this.peek() !== '(') {
      name = this.next();
    }
    const varDefs: Array<{ name: string; defaultValue: GqlValue | null }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const vname = this.next();
        if (!vname.startsWith('$')) throw new Error('expected variable in definition');
        // Type: a name, possibly wrapped in [ ] or followed by !.
        while (this.peek() !== undefined && this.peek() !== ')' && this.peek() !== ',' && this.peek() !== '=') this.next();
        let def: GqlValue | null = null;
        if (this.peek() === '=') {
          this.next();
          def = this.parseValue();
        }
        varDefs.push({ name: vname.slice(1), defaultValue: def });
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { type, name, varDefs, selections };
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const out: GqlSelection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new Error('unterminated selection set');
      out.push(this.parseSelection());
    }
    this.expect('}');
    return out;
  }

  private parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      let typeName: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        typeName = this.next();
      }
      return { kind: 'inline', typeName, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Array<[string, GqlValue]> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push([argName, this.parseValue()]);
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    let selections: GqlSelection[] | null = null;
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { kind: 'field', field: { alias, name, args, selections } };
  }

  private parseValue(): GqlValue {
    const tok = this.next();
    if (tok === undefined) throw new Error('unexpected end of GraphQL value');
    if (tok === '$' || tok.startsWith('$')) return { kind: 'var', name: tok.slice(1) };
    if (tok === 'true') return { kind: 'bool', value: true };
    if (tok === 'false') return { kind: 'bool', value: false };
    if (tok === 'null') return { kind: 'null' };
    if (tok.startsWith('"')) return { kind: 'string', value: JSON.parse(tok) as string };
    if (tok === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']') {
        items.push(this.parseValue());
        if (this.peek() === ',') this.next();
      }
      this.expect(']');
      return { kind: 'list', items };
    }
    if (tok === '{') {
      const fields: Array<[string, GqlValue]> = [];
      while (this.peek() !== '}') {
        const fname = this.next();
        this.expect(':');
        fields.push([fname, this.parseValue()]);
        if (this.peek() === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (/^-?\d+$/.test(tok)) return { kind: 'int', value: Number(tok) };
    if (/^-?\d*\.\d+$/.test(tok)) return { kind: 'float', value: Number(tok) };
    return { kind: 'enum', value: tok };
  }
}

function gqlResolveValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'enum':
      return v.value;
    case 'null':
      return null;
    case 'var': {
      const val = vars[v.name];
      return val === undefined ? null : val;
    }
    case 'list':
      return v.items.map((i) => gqlResolveValue(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of v.fields) out[k] = gqlResolveValue(val, vars);
      return out;
    }
  }
}

function gqlArg(field: GqlField, name: string, vars: Record<string, unknown>): unknown {
  const found = field.args.find(([n]) => n === name);
  return found ? gqlResolveValue(found[1], vars) : undefined;
}

// Opaque global ids: base64url of "<Type>:<key>".
function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const idx = text.indexOf(':');
    if (idx <= 0) return null;
    return { type: text.slice(0, idx), key: text.slice(idx + 1) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', String(repo.id));
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}

function prGlobalId(repo: Repo, pr: PullRequest): string {
  return globalId('PullRequest', `${repo.id}:${pr.number}`);
}

function findRepoById(id: string): Repo | undefined {
  const n = Number(id);
  if (!Number.isFinite(n)) return undefined;
  return [...repos.values()].find((r) => r.id === n);
}

// Type-name tables for introspection and unknown-field errors.
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  User: ['login', 'id'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests'],
  BranchRef: ['name'],
  Issue: ['id', 'number', 'title', 'body', 'state'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes'],
  FileConnection: ['nodes'],
  File: ['path'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  IssueComment: ['id', 'body'],
  IssueCommentEdge: ['node'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const TYPE_KIND: Record<string, string> = {
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  Repository: 'OBJECT',
  SearchType: 'ENUM',
};

interface GqlCtx {
  vars: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function issueStateEnum(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function prStateEnum(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64url');
}

function decodeCursor(c: string): number | null {
  try {
    const text = Buffer.from(c, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Resolve one object's selections. `typeName` is the GraphQL type of `value`. */
function resolveSelections(typeName: string, value: unknown, selections: GqlSelection[], ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inline') {
      if (sel.typeName === null || sel.typeName === typeName) {
        Object.assign(out, resolveSelections(typeName, value, sel.selections, ctx));
      }
      continue;
    }
    const f = sel.field;
    const key = f.alias ?? f.name;
    const fields = TYPE_FIELDS[typeName] ?? [];
    if (f.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (!fields.includes(f.name)) {
      ctx.errors.push({ message: `Cannot query field "${f.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    out[key] = resolveField(typeName, value, f, ctx);
  }
  return out;
}

function resolveField(typeName: string, value: unknown, field: GqlField, ctx: GqlCtx): unknown {
  const sub = field.selections;
  const need = (v: unknown, t: string): unknown => (sub ? resolveSelections(t, v, sub, ctx) : v);

  if (typeName === 'Query') {
    if (field.name === 'viewer') return need({ login: VIEWER_LOGIN, id: 1000 }, 'User');
    if (field.name === 'repository') {
      const owner = String(gqlArg(field, 'owner', ctx.vars) ?? '');
      const name = String(gqlArg(field, 'name', ctx.vars) ?? '');
      const repo = getRepo(owner, name);
      if (!repo) return null;
      return need(repo, 'Repository');
    }
    if (field.name === 'node') {
      const id = String(gqlArg(field, 'id', ctx.vars) ?? '');
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.type === 'Repository') {
        const repo = findRepoById(decoded.key);
        if (!repo) return null;
        return need(repo, 'Repository');
      }
      if (decoded.type === 'Issue') {
        const [repoId, num] = decoded.key.split(':');
        const repo = findRepoById(repoId);
        const issue = repo?.issues.find((i) => i.number === Number(num));
        if (!repo || !issue) return null;
        return need({ repo, issue }, 'Issue');
      }
      if (decoded.type === 'PullRequest') {
        const [repoId, num] = decoded.key.split(':');
        const repo = findRepoById(repoId);
        const pr = repo?.prs.find((p) => p.number === Number(num));
        if (!repo || !pr) return null;
        return need({ repo, pr }, 'PullRequest');
      }
      return null;
    }
  }

  if (typeName === 'User') {
    const u = value as { login: string; id: number };
    if (field.name === 'login') return u.login;
    if (field.name === 'id') return globalId('User', String(u.id));
  }

  if (typeName === 'Repository') {
    const repo = value as Repo;
    switch (field.name) {
      case 'id':
        return repoGlobalId(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return need({ login: repo.owner, id: 1000 }, 'User');
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return null;
        return need({ name: repo.defaultBranch }, 'BranchRef');
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const num = Number(gqlArg(field, 'number', ctx.vars));
        const issue = repo.issues.find((i) => i.number === num);
        if (!issue) return null;
        return need({ repo, issue }, 'Issue');
      }
      case 'issues': {
        const first = Number(gqlArg(field, 'first', ctx.vars) ?? 100);
        const after = gqlArg(field, 'after', ctx.vars);
        const states = (gqlArg(field, 'states', ctx.vars) as string[] | undefined) ?? null;
        const orderBy = (gqlArg(field, 'orderBy', ctx.vars) as Record<string, unknown> | undefined) ?? null;
        let list = [...repo.issues];
        if (states) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        const dir = String(orderBy?.direction ?? 'DESC').toUpperCase();
        list.sort((a, b) => (dir === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
        let start = 0;
        if (typeof after === 'string' && after !== '') {
          const afterNum = decodeCursor(after);
          if (afterNum !== null) {
            const idx = list.findIndex((i) => i.number === afterNum);
            if (idx >= 0) start = idx + 1;
          }
        }
        const page = list.slice(start, start + first);
        const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
        const conn = {
          nodes: page.map((i) => ({ repo, issue: i })),
          pageInfo: { hasNextPage: start + first < list.length, endCursor },
        };
        return need(conn, 'IssueConnection');
      }
      case 'pullRequest': {
        const num = Number(gqlArg(field, 'number', ctx.vars));
        const pr = repo.prs.find((p) => p.number === num);
        if (!pr) return null;
        return need({ repo, pr }, 'PullRequest');
      }
      case 'pullRequests': {
        const first = Number(gqlArg(field, 'first', ctx.vars) ?? 100);
        const list = [...repo.prs].sort((a, b) => b.seq - a.seq).slice(0, first);
        return need({ nodes: list.map((p) => ({ repo, pr: p })) }, 'PullRequestConnection');
      }
    }
  }

  if (typeName === 'BranchRef') {
    const b = value as { name: string };
    if (field.name === 'name') return b.name;
  }

  if (typeName === 'Issue') {
    const v = value as { repo: Repo; issue: Issue };
    switch (field.name) {
      case 'id':
        return issueGlobalId(v.repo, v.issue);
      case 'number':
        return v.issue.number;
      case 'title':
        return v.issue.title;
      case 'body':
        return v.issue.body;
      case 'state':
        return issueStateEnum(v.issue.state);
    }
  }

  if (typeName === 'IssueConnection') {
    const c = value as { nodes: Array<{ repo: Repo; issue: Issue }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    if (field.name === 'nodes') return c.nodes.map((n) => need(n, 'Issue'));
    if (field.name === 'pageInfo') return need(c.pageInfo, 'PageInfo');
  }

  if (typeName === 'PageInfo') {
    const p = value as { hasNextPage: boolean; endCursor: string | null };
    if (field.name === 'hasNextPage') return p.hasNextPage;
    if (field.name === 'endCursor') return p.endCursor;
  }

  if (typeName === 'PullRequest') {
    const v = value as { repo: Repo; pr: PullRequest };
    const pr = v.pr;
    const repo = v.repo;
    switch (field.name) {
      case 'id':
        return prGlobalId(repo, pr);
      case 'number':
        return pr.number;
      case 'title':
        return pr.title;
      case 'body':
        return pr.body;
      case 'state':
        return prStateEnum(pr);
      case 'merged':
        return pr.merged;
      case 'headRefName':
        return pr.headRef;
      case 'baseRefName':
        return pr.baseRef;
      case 'mergeable': {
        if (pr.state !== 'open') return 'UNKNOWN';
        const baseTip = resolveRef(repo, pr.baseRef);
        const headTip = resolveRef(repo, pr.headRef);
        if (!baseTip || !headTip) return 'UNKNOWN';
        return mergeConflicts(repo, pr.baseTree, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'files': {
        const first = Number(gqlArg(field, 'first', ctx.vars) ?? 100);
        const before = new Map<string, { oid: string; mode: string }>();
        flattenTree(repo, pr.baseTree, '', before);
        const after = treeFiles(repo, pr.headSha);
        const diffs = diffFiles(before, after).slice(0, first);
        return need({ nodes: diffs.map((d) => ({ path: d.path })) }, 'FileConnection');
      }
    }
  }

  if (typeName === 'PullRequestConnection') {
    const c = value as { nodes: Array<{ repo: Repo; pr: PullRequest }> };
    if (field.name === 'nodes') return c.nodes.map((n) => need(n, 'PullRequest'));
  }

  if (typeName === 'FileConnection') {
    const c = value as { nodes: Array<{ path: string }> };
    if (field.name === 'nodes') return c.nodes.map((n) => need(n, 'File'));
  }

  if (typeName === 'File') {
    const f = value as { path: string };
    if (field.name === 'path') return f.path;
  }

  if (typeName === 'IssueComment') {
    const c = value as { id: number; body: string; repo: Repo; issue: Issue };
    if (field.name === 'id') return globalId('IssueComment', `${c.repo.id}:${c.issue.number}:${c.id}`);
    if (field.name === 'body') return c.body;
  }

  if (typeName === 'IssueCommentEdge') {
    const e = value as { node: unknown };
    if (field.name === 'node') return need(e.node, 'IssueComment');
  }

  if (typeName === '__Type') {
    const t = value as { name: string };
    if (field.name === 'name') return t.name;
    if (field.name === 'fields') {
      const names = TYPE_FIELDS[t.name] ?? [];
      return names.map((n) => need({ name: n }, '__Field'));
    }
    if (field.name === 'enumValues') {
      if (t.name === 'SearchType') return [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }].map((e) => need(e, '__EnumValue'));
      return [];
    }
  }

  if (typeName === '__Field') {
    const f = value as { name: string };
    if (field.name === 'name') return f.name;
  }

  if (typeName === '__EnumValue') {
    const e = value as { name: string };
    if (field.name === 'name') return e.name;
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    const p = value as { issue: unknown };
    if (field.name === 'issue') return need(p.issue, 'Issue');
  }

  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    const p = value as { pullRequest: unknown };
    if (field.name === 'pullRequest') return need(p.pullRequest, 'PullRequest');
  }

  if (typeName === 'AddCommentPayload') {
    const p = value as { commentEdge: unknown };
    if (field.name === 'commentEdge') return need(p.commentEdge, 'IssueCommentEdge');
  }

  return null;
}

function executeMutation(op: GqlOperation, ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.kind !== 'field') continue;
    const f = sel.field;
    const key = f.alias ?? f.name;
    const input = (gqlArg(f, 'input', ctx.vars) ?? {}) as Record<string, unknown>;
    const sub = f.selections ?? [];
    if (f.name === 'createIssue') {
      const repo = findRepoById(String(input.repositoryId ?? ''));
      // repositoryId may be a global id.
      const repo2 = repo ?? findRepoByGlobalId(String(input.repositoryId ?? ''));
      if (!repo2) {
        ctx.errors.push({ message: 'Repository not found' });
        out[key] = null;
        continue;
      }
      const issue: Issue = {
        number: repo2.nextIssue++,
        id: nextGlobalId++,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        seq: ++globalSeq,
      };
      repo2.issues.push(issue);
      out[key] = resolveSelections('CreateIssuePayload', { issue: { repo: repo2, issue } }, sub, ctx);
      continue;
    }
    if (f.name === 'closeIssue') {
      const target = findIssueByGlobalId(String(input.issueId ?? ''));
      if (!target) {
        ctx.errors.push({ message: 'Issue not found' });
        out[key] = null;
        continue;
      }
      target.issue.state = 'closed';
      out[key] = resolveSelections('CloseIssuePayload', { issue: target }, sub, ctx);
      continue;
    }
    if (f.name === 'createPullRequest') {
      const repo = findRepoByGlobalId(String(input.repositoryId ?? '')) ?? findRepoById(String(input.repositoryId ?? ''));
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found' });
        out[key] = null;
        continue;
      }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = resolveRef(repo, headRef);
      const baseSha = resolveRef(repo, baseRef);
      if (!headSha || !baseSha) {
        ctx.errors.push({ message: 'head or base ref does not exist' });
        out[key] = null;
        continue;
      }
      const existing = repo.prs.find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
      if (existing) {
        out[key] = resolveSelections('CreatePullRequestPayload', { pullRequest: { repo, pr: existing } }, sub, ctx);
        continue;
      }
      const baseTree = parseCommit(repo.objects.get(baseSha)!.data).tree;
      const pr: PullRequest = {
        number: repo.nextPr++,
        id: nextGlobalId++,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef,
        baseRef,
        headSha,
        baseSha,
        baseTree,
        seq: ++globalSeq,
      };
      repo.prs.push(pr);
      out[key] = resolveSelections('CreatePullRequestPayload', { pullRequest: { repo, pr } }, sub, ctx);
      continue;
    }
    if (f.name === 'mergePullRequest') {
      const target = findPrByGlobalId(String(input.pullRequestId ?? ''));
      if (!target) {
        ctx.errors.push({ message: 'Pull request not found' });
        out[key] = null;
        continue;
      }
      const { repo, pr } = target;
      if (pr.state === 'open') {
        const baseTip = resolveRef(repo, pr.baseRef);
        const headTip = resolveRef(repo, pr.headRef);
        if (baseTip && headTip && !mergeConflicts(repo, pr.baseTree, baseTip, headTip)) {
          const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
          const squashOid = storeObject(repo, 'commit', buildCommit(headTree, [baseTip], pr.title));
          repo.refs.set(`refs/heads/${pr.baseRef}`, squashOid);
          pr.state = 'closed';
          pr.merged = true;
          pr.mergedAt = '2025-01-01T00:00:00Z';
          pr.mergeCommitSha = squashOid;
        }
      }
      out[key] = resolveSelections('MergePullRequestPayload', { pullRequest: { repo, pr } }, sub, ctx);
      continue;
    }
    if (f.name === 'addComment') {
      const target = findIssueByGlobalId(String(input.subjectId ?? ''));
      if (!target) {
        ctx.errors.push({ message: 'Issue not found' });
        out[key] = null;
        continue;
      }
      const comment = { id: target.repo.nextComment++, body: String(input.body ?? '') };
      target.issue.comments.push(comment);
      const node = { id: comment.id, body: comment.body, repo: target.repo, issue: target.issue };
      out[key] = resolveSelections('AddCommentPayload', { commentEdge: { node } }, sub, ctx);
      continue;
    }
    ctx.errors.push({ message: `Cannot query field "${f.name}" on type "Mutation".` });
    out[key] = null;
  }
  return out;
}

function findRepoByGlobalId(id: string): Repo | undefined {
  const decoded = decodeGlobalId(id);
  if (!decoded) return undefined;
  if (decoded.type === 'Repository') return findRepoById(decoded.key);
  return undefined;
}

function findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Issue') return null;
  const [repoId, num] = decoded.key.split(':');
  const repo = findRepoById(repoId);
  const issue = repo?.issues.find((i) => i.number === Number(num));
  return repo && issue ? { repo, issue } : null;
}

function findPrByGlobalId(id: string): { repo: Repo; pr: PullRequest } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'PullRequest') return null;
  const [repoId, num] = decoded.key.split(':');
  const repo = findRepoById(repoId);
  const pr = repo?.prs.find((p) => p.number === Number(num));
  return repo && pr ? { repo, pr } : null;
}

function executeOperation(op: GqlOperation, variables: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
  const ctx: GqlCtx = { vars: { ...variables }, errors: [] };
  for (const def of op.varDefs) {
    if (ctx.vars[def.name] === undefined && def.defaultValue !== null) {
      ctx.vars[def.name] = gqlResolveValue(def.defaultValue, ctx.vars);
    }
  }
  if (op.type === 'mutation') {
    const data = executeMutation(op, ctx);
    return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
  }
  // Queries: resolve against the Query root; __type is a meta-field on Query.
  const data: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.kind === 'inline') continue;
    const f = sel.field;
    const key = f.alias ?? f.name;
    if (f.name === '__type') {
      const typeName = String(gqlArg(f, 'name', ctx.vars) ?? '');
      const typeObj = { name: typeName };
      data[key] = f.selections ? resolveSelections('__Type', typeObj, f.selections, ctx) : typeObj;
      continue;
    }
    if (f.name === '__schema') {
      data[key] = f.selections ? resolveSelections('__Schema', {}, f.selections, ctx) : {};
      continue;
    }
    data[key] = resolveField('Query', null, f, ctx);
  }
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  if (!authed(req)) {
    res.writeHead(401, { 'content-type': 'application/json', 'x-github-request-id': nextRequestId() });
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return;
  }
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    jsonError(res, 400, 'Invalid JSON');
    return;
  }
  const runOne = (doc: unknown): unknown => {
    const d = (doc ?? {}) as Record<string, unknown>;
    const query = typeof d.query === 'string' ? d.query : '';
    const variables = (d.variables ?? {}) as Record<string, unknown>;
    if (query === '') return { data: null, errors: [{ message: 'No query provided' }] };
    let ops: GqlOperation[];
    try {
      ops = new GqlParser(gqlTokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: (err as Error).message }] };
    }
    const opName = typeof d.operationName === 'string' ? d.operationName : null;
    const op = ops.length === 1 ? ops[0] : ops.find((o) => o.name === opName) ?? ops[0];
    if (!op) return { data: null, errors: [{ message: 'Unknown operation' }] };
    try {
      return executeOperation(op, variables);
    } catch (err) {
      return { data: null, errors: [{ message: (err as Error).message }] };
    }
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed.value));
}

// ---------------------------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 Streamable HTTP)
// ---------------------------------------------------------------------------------------------

const MCP_TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        owner: { type: 'string', description: 'Owner login (defaults to the viewer)' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        number: { type: 'integer', description: 'Pull request number (alias)' },
        merge_method: { type: 'string', description: 'Merge method (squash)' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** Normalize tool arguments: accept synonyms the suite may use (repo/name, full_name, number). */
function mcpRepoArgs(args: Record<string, unknown>): { owner: string; name: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let name = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  const full = typeof args.full_name === 'string' ? args.full_name : '';
  if (full.includes('/')) {
    const [o, n] = full.split('/');
    if (!owner) owner = o;
    if (!name) name = n;
  }
  if (!owner) owner = VIEWER_LOGIN;
  return { owner, name };
}

function mcpToolResult(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'create_repo') {
    const repoName = typeof args.name === 'string' ? args.name : '';
    if (repoName === '') return mcpToolError('name is required');
    const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN;
    if (getRepo(owner, repoName)) return mcpToolError(`Repository ${owner}/${repoName} already exists`);
    const repo = createRepo(owner, repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
    return mcpToolResult({ ...repoJson(repo), full_name: `${owner}/${repoName}` });
  }
  if (name === 'get_repo') {
    const { owner, name: repoName } = mcpRepoArgs(args);
    const repo = getRepo(owner, repoName);
    if (!repo) return mcpToolError(`Repository ${owner}/${repoName} not found`);
    return mcpToolResult(repoJson(repo));
  }
  if (name === 'create_issue') {
    const { owner, name: repoName } = mcpRepoArgs(args);
    const title = typeof args.title === 'string' ? args.title : '';
    if (repoName === '' || title === '') return mcpToolError('owner, repo and title are required');
    const repo = getRepo(owner, repoName);
    if (!repo) return mcpToolError(`Repository ${owner}/${repoName} not found`);
    const issue: Issue = {
      number: repo.nextIssue++,
      id: nextGlobalId++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      comments: [],
      seq: ++globalSeq,
    };
    repo.issues.push(issue);
    return mcpToolResult({ number: issue.number, id: issue.id, title: issue.title, body: issue.body, state: 'open' });
  }
  if (name === 'list_issues') {
    const { owner, name: repoName } = mcpRepoArgs(args);
    const repo = getRepo(owner, repoName);
    if (!repo) return mcpToolError(`Repository ${owner}/${repoName} not found`);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
    const issues = list.map((i) => ({ number: i.number, id: i.id, title: i.title, body: i.body, state: i.state }));
    return mcpToolResult({ issues });
  }
  if (name === 'create_pull_request') {
    const { owner, name: repoName } = mcpRepoArgs(args);
    const title = typeof args.title === 'string' ? args.title : '';
    const headRef = typeof args.head === 'string' ? args.head : '';
    const baseRef = typeof args.base === 'string' ? args.base : 'main';
    if (repoName === '' || title === '' || headRef === '') return mcpToolError('owner, repo, title, head and base are required');
    const repo = getRepo(owner, repoName);
    if (!repo) return mcpToolError(`Repository ${owner}/${repoName} not found`);
    const headSha = resolveRef(repo, headRef);
    const baseSha = resolveRef(repo, baseRef);
    if (!headSha || !baseSha) return mcpToolError('head or base ref does not exist');
    const dup = repo.prs.find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
    if (dup) return mcpToolError('A pull request already exists for this head and base');
    const baseTree = parseCommit(repo.objects.get(baseSha)!.data).tree;
    const pr: PullRequest = {
      number: repo.nextPr++,
      id: nextGlobalId++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      baseTree,
      seq: ++globalSeq,
    };
    repo.prs.push(pr);
    return mcpToolResult({ number: pr.number, id: pr.id, title: pr.title, body: pr.body, state: 'open', head: { ref: headRef, sha: headSha }, base: { ref: baseRef, sha: baseSha } });
  }
  if (name === 'merge_pull_request') {
    const { owner, name: repoName } = mcpRepoArgs(args);
    const numRaw = args.pull_number ?? args.number ?? args.pullNumber;
    const num = Number(numRaw);
    if (repoName === '' || !Number.isFinite(num)) return mcpToolError('owner, repo and pull_number are required');
    const repo = getRepo(owner, repoName);
    if (!repo) return mcpToolError(`Repository ${owner}/${repoName} not found`);
    const pr = repo.prs.find((p) => p.number === num);
    if (!pr) return mcpToolError(`Pull request #${num} not found`);
    if (pr.state !== 'open') return mcpToolError('Pull request is not open');
    const baseTip = resolveRef(repo, pr.baseRef);
    const headTip = resolveRef(repo, pr.headRef);
    if (!baseTip || !headTip) return mcpToolError('head or base ref does not exist');
    if (mergeConflicts(repo, pr.baseTree, baseTip, headTip)) return mcpToolError('Merge conflict');
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const squashOid = storeObject(repo, 'commit', buildCommit(headTree, [baseTip], pr.title));
    repo.refs.set(`refs/heads/${pr.baseRef}`, squashOid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = '2025-01-01T00:00:00Z';
    pr.mergeCommitSha = squashOid;
    return mcpToolResult({ number: pr.number, merged: true, sha: squashOid, state: 'closed' });
  }
  return mcpToolError(`Unknown tool: ${name}`);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  const sendRpc = (status: number, payload: unknown): void => {
    sendJson(res, status, payload);
  };
  if (!authed(req)) {
    sendRpc(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendRpc(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const msg = (parsed.value ?? {}) as Record<string, unknown>;
  const id = (msg.id ?? null) as string | number | null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id: acknowledge with 202 and no body.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }

  const serverInfo = { name: 'github-core-clone', version: VERSION };
  if (method === 'server/discover') {
    sendRpc(200, {
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      },
    });
    return;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    sendRpc(200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      },
    });
    return;
  }
  if (method === 'tools/list') {
    sendRpc(200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!MCP_TOOLS.some((t) => t.name === toolName)) {
      sendRpc(200, { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${toolName}` } });
      return;
    }
    const required = (MCP_TOOLS.find((t) => t.name === toolName)!.inputSchema as Record<string, unknown>).required as string[];
    const missing = required.filter((r) => {
      if (r === 'pull_number') return args.pull_number === undefined && args.number === undefined && args.pullNumber === undefined;
      if (r === 'repo') return args.repo === undefined && args.name === undefined && args.full_name === undefined;
      if (r === 'owner') return args.owner === undefined && args.full_name === undefined;
      return args[r] === undefined;
    });
    if (missing.length > 0) {
      sendRpc(200, { jsonrpc: '2.0', id, result: mcpToolError(`Missing required arguments: ${missing.join(', ')}`) });
      return;
    }
    const result = mcpCallTool(toolName, args);
    sendRpc(200, { jsonrpc: '2.0', id, result });
    return;
  }
  if (method === 'ping') {
    sendRpc(200, { jsonrpc: '2.0', id, result: {} });
    return;
  }
  sendRpc(200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

export function createApp(): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const rawUrl = req.url ?? '/';
        const url = new URL(rawUrl, 'http://localhost');
        let pathname: string;
        try {
          pathname = decodeURIComponent(url.pathname);
        } catch {
          pathname = url.pathname;
        }
        const segments = pathname.split('/').filter((s) => s !== '');
        const body = await readBody(req);
        if (segments.length >= 1 && segments[0] === 'api' && segments[1] === 'v3') {
          await handleRest(req, res, segments.slice(2), url.searchParams, body);
          return;
        }
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          await handleGraphql(req, res, body);
          return;
        }
        if (segments.length === 1 && segments[0] === 'mcp') {
          await handleMcp(req, res, body);
          return;
        }
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          await handleGit(req, res, segments, url.searchParams, body);
          return;
        }
        jsonError(res, 404, 'Not Found');
      } catch (err) {
        // Never let one bad request kill the process; the suite keeps going after errors.
        try {
          jsonError(res, 500, (err as Error).message);
        } catch {
          // Response already gone; nothing left to do.
        }
      }
    })();
  });
  return server;
}
