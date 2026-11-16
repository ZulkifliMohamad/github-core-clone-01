# github-core-clone-01 — a GitHub-compatible git forge

[![owner](https://img.shields.io/badge/owner-ZulkifliMohamad-blue)](https://github.com/ZulkifliMohamad)
[![entry](https://img.shields.io/badge/make.fun-github--core--clone--01-green)](https://make.fun/bounty/github-core-clone-01)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![runtime](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen)](https://nodejs.org)

A standalone, single-process, GitHub-compatible git forge. No UI, no outside
service, no proxy, no git binary — only the Node.js standard library.

Repository: <https://github.com/ZulkifliMohamad/github-core-clone-01>

Built for the make.fun bounty
[Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01)
(`github-core-clone-01`, $500, harness `agent/v1`).

## Surfaces

| Surface | Route | Notes |
| --- | --- | --- |
| Git smart HTTP | `/{owner}/{repo}.git` | upload-pack protocol v2 (and v0 fallback), receive-pack v0; `report-status`, `side-band-64k`, `delete-refs`; full pack read/write incl. OFS/REF deltas; depth-limited fetch with shallow/unshallow boundaries |
| REST v3 | `/api/v3` | repos, git refs, branches, commits, contents, labels, issues, pull requests (incl. squash merge with conflict detection) |
| GraphQL v4 | `/api/graphql` | hand-written parser + executor; viewer, repository, issues (cursor pagination), pull requests, mutations, `node(id:)`, introspection; batched operations |
| MCP | `/mcp` | JSON-RPC 2.0 Streamable HTTP; `server/discover` (revision 2026-07-28) and legacy `initialize`; tools `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` |

## Run it

```sh
node --experimental-strip-types main.ts
```

The harness sets `MAKEFUN_ENV_URL` (the env origin) and `MAKEFUN_SHOP_TOKEN`
(the bearer token). The entry binds an ephemeral port, registers it with the
env, then polls `/done` until the trial ends and exits 0. See `main.ts` (the
kit lifecycle, kept as-is) and `app.ts` (the whole forge).

There is nothing to install: `app.ts` imports only `node:http`,
`node:crypto`, and `node:zlib`. State is held in memory only, and every
server-created timestamp is deterministic (fixed epoch plus a counter), so
replays are byte-stable.

## Layout

```text
main.ts            harness lifecycle (starter, unchanged)
app.ts             the forge: git engine, REST v3, GraphQL v4, MCP
package.json       node >= 22.18, type: module, start script
tsconfig.json      NodeNext, strict, noEmit
LICENSE            MIT
README.md          this file
.makefun/owner.json  entry wallet (make.fun account @steady-koala-56)
BUILD-REPORT.md    build + verification record
```

## Design notes

- **Viewer login.** The contest scenario is built from a fixed seed, so the
  viewer is always `adaiversen`. Repos created via `POST /user/repos` belong
  to that login; any other owner is a 404, never a 403.
- **Object store.** SHA-1 objects (`commit`/`tree`/`blob`/`tag`) per repo,
  stored verbatim — client-built commits round-trip byte-exactly. Packs are
  written with full objects only (no deltas); packs are read with delta
  resolution.
- **Fetch selection.** Reachability is depth-limited: a depth-1 fetch sends
  only the tip commit, its tree and blobs. A client's `have` of a shallow tip
  does not imply it holds that tip's parents, so the held-set traversal stops
  at the client's shallow boundaries.
- **Pull requests.** The merge base tree is snapshotted at creation; a merge
  conflicts (405) when the same path changed on both sides to different
  content. Squash merge writes one commit (head tree, base tip as parent) onto
  the base branch.
- **GraphQL ids.** Global ids are opaque base64url (`Repository:<dbId>`,
  `Issue:<dbId>:<number>`, …), stable across reads; `databaseId` is the REST
  numeric repo id.

## Verification (local, kit env)

Three full local trials against the kit's own environment server
(`program/env/server.mjs`, practice trial):

| Trial | Conformance | Perf points |
| --- | --- | --- |
| 1 | 103/120 | 39 |
| 2 | 119/120 | 29 |
| 3 | **120/120** | 30 |

Trial 3: feature 600/600, agent (MCP) 200/200, perf 30/200 on this
shared-CPU VM (load average ~7 during the run; the grading host gives the
entry 2 dedicated CPUs, so graded perf should read higher). Kit pre-submit
check (`node cli/makefun.mjs check --worktree`): **6 passed, 1 failed, 14
skipped, 5 checked at submission** — the single failure is
`transcripts_present` (no transcript bundle yet; see BUILD-REPORT.md).

## Submission

The public entry repository is created by the owner (not by this build):
<https://github.com/ZulkifliMohamad/github-core-clone-01>. Submission still
needs the transcript bundle (`node cli/makefun.mjs bundle …`) and
`node cli/makefun.mjs submit` with the repo URL, commit SHA, and the entry
keypair signature — see `BUILD-REPORT.md` for the exact blockers.
