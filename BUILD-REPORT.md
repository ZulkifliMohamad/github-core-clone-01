# BUILD-REPORT — github-core-clone-01

Bounty: **Build a GitHub-compatible git forge** (`github-core-clone-01`,
$500, deadline 2026-11-21T06:30:00Z, harness `agent/v1`).
Account: make.fun **@steady-koala-56**, wallet
`4o4WqB3G7im2t3Y1FFzaeeKFJ9zVtWQHNy3HY6gQArwo`.
GitHub owner for the entry repo: **ZulkifliMohamad**.
Built: 2026-11-16. Status: **built and locally verified; not submitted**.

## What was built

A standalone, single-process, GitHub-compatible git forge in
`~/workspace/makefun/github-core-clone-01/`, Node.js stdlib only
(`node:http`, `node:crypto`, `node:zlib`), no dependencies, no git binary.
All files, code, comments, and docs are in English.

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack protocol v2 and v0,
  receive-pack v0; `report-status`, `side-band-64k`, `delete-refs`; SHA-1
  object store with verbatim client-built commits; pack read (OFS/REF deltas)
  and write (full objects); depth-limited fetch with shallow/unshallow
  boundaries; fast-forward enforcement (`non-fast-forward` refusals).
- **REST v3** (`/api/v3`): repos (create/read/patch/delete, `Link`
  pagination), git refs, branches, commits, contents (create/update/delete
  with blob-SHA optimistic concurrency, 409 on stale SHA), labels, issues
  (incl. comments), pull requests (incl. squash merge, 405 on conflict).
- **GraphQL v4** (`/api/graphql`): hand-written parser + executor; viewer,
  repository, issues with cursor pagination, pull requests, mutations
  (create/close issue, create/merge PR, add comment), `node(id:)`,
  introspection, batched operations.
- **MCP** (`/mcp`): JSON-RPC 2.0; `server/discover` (2026-07-28) and legacy
  `initialize`; tools `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`.
- In-memory store; deterministic server-created timestamps (fixed epoch +
  counter); viewer login `adaiversen` (fixed by the contest scenario seed).

## File list

| File | Size | Notes |
| --- | --- | --- |
| `main.ts` | 4,676 B | Harness lifecycle, kit starter unchanged |
| `app.ts` | ~115 KB | The whole forge |
| `package.json` | 370 B | node >= 22.18, `type: module` |
| `tsconfig.json` | 291 B | NodeNext, strict, noEmit |
| `LICENSE` | 1,104 B | MIT |
| `README.md` | ~4.9 KB | Entry docs, owner ZulkifliMohamad |
| `BUILD-REPORT.md` | this file | |
| `.makefun/owner.json` | 58 B | `{"wallet": "4o4WqB3G7im2t3Y1FFzaeeKFJ9zVtWQHNy3HY6gQArwo"}` |

Total ~127 KB — far under the 16 MiB tree / 8 MiB per-file caps.

## Check results

### Kit environment trials (local, `program/env/server.mjs`, practice trial)

| Trial | Conformance (120 checks) | Perf points (200 max) |
| --- | --- | --- |
| 1 | 103/120 | 39 (push 18, clone 0, read 10, write 11) |
| 2 | 119/120 | 29 (push 15, clone 14, read 0, write 0) |
| 3 | **120/120** | 30 (push 12, clone 3, read 9, write 6) |

Trial 3 details: feature 600/600, agent (MCP) 200/200. Perf medians vs
reference (T_ref): push 3294 ms (ref 1641), clone 918 ms (ref 267), read
6704 ms (ref 2760), write 1000 ms (ref 349). Perf varied a lot between
trials (e.g. clone 479 ms in trial 2 vs 918 ms in trial 3) because this VM
was heavily loaded by other work (load average ~7 during trial 2); the
grading host gives the entry 2 dedicated CPUs, so graded perf should read
higher. No code change was made for perf — the per-request work is already
minimal (Map lookups, one JSON round-trip).

Bugs found and fixed across the trials: GraphQL tokenizer split `$var`
into `$` + `var` (broke every document with variables); fetch sent full
history past `deepen` (reachable closure ignored the depth limit); tag
objects were never sent on fetch; a shallow `have` was treated as holding
its parents (broke `fetch-shallow-deepen`).

### Kit pre-submit check (`node cli/makefun.mjs check --worktree`)

**6 passed, 1 failed, 14 skipped, 5 checked at submission.**

- Pass: `competition_open`, `snapshot`, `license_osi` (MIT),
  `entrypoint` (main.ts → node22), `entry_size`, `committed_provider_key`
  (no provider key in any text file).
- Fail: `transcripts_present` — no transcript bundle was supplied (see
  blockers). All transcript-gate checks skipped for the same reason.
- At submission (site-side): `repo_public`, `repo_owner`, `repo_created_after_open`,
  `commit_in_repo`, `duplicate_snapshot`.

## What still blocks submission (parent / owner steps)

1. **GitHub repo does not exist yet.** Create public repo
   `ZulkifliMohamad/github-core-clone-01` (after the 2026-11-14 opening —
   any time now qualifies), push this entry to it. Do not create it from
   this build; the parent creates it via
   `~/workspace/custom-connectors/custom.github/bin/github.py`.
   (`repo_public`, `repo_created_after_open`, `commit_in_repo`.)
2. **Transcript bundle.** Bundle the agent sessions that built this entry
   (`node cli/makefun.mjs bundle --repo <repo> --system-prompt <file>
   --effort <level> --out transcripts.tar.gz`, run from inside the unpacked
   kit, from the top-level agent once subagents have finished). This session
   is the build record; the bundle is what the transcript gate grades.
   (`transcripts_present` and the whole thinking gate.)
3. **Submit.** `node cli/makefun.mjs submit` with `repo_url`, `commit_sha`,
   the transcript bundle, and the entry keypair signature
   (`~/.makefun/credentials` holds the API key; the Solana keypair is at
   `~/workspace/user/wallets/muse-solana/id.json`). No fee, no GitHub token
   needed for submission itself.
4. **Deadline:** 2026-11-21T06:30:00Z.

## Not done by this build (per task constraints)

- Entry was NOT submitted. No GitHub repo was created. No fee was paid.
- The make.fun API key and the Solana private key were never printed,
  copied, or written anywhere except their existing 0600 files.
- Local test tokens only (`shpat_0123…` dummy) were used for trial runs.
