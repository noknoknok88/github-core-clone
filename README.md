# Merlin Forge — a GitHub-compatible git forge in TypeScript

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/noknoknok88/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/noknoknok88/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone entry for [github-core-clone-01](https://make.fun/bounty/github-core-clone-01): one Node 22
process, stdlib only, no dependencies, no `git` binary, no network beyond the suite. It implements
the whole scored surface on a single in-memory store: git smart HTTP, REST v3, GraphQL v4, and MCP.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http`, `node:crypto`, `node:zlib` and its own modules only, and the trial
has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. A missing or wrong token is
refused with 401 JSON; a repo under another owner is 404, never 403.

## How it works

- **Git** (`git.ts`): protocol v2 (ls-refs, fetch, shallow/deepen) plus a v0 fallback, receive-pack
  v0 with per-ref fast-forward checks and sideband reports. Packfiles are written undeltified and
  read with full OFS_DELTA/REF_DELTA support. Object selection for fetch is exact:
  reachable(wants) minus reachable(haves), with shallow boundaries respected.
- **Store** (`store.ts`): repos, refs, objects, issues, pull requests and comments in Maps; tree
  diffing, three-way merge-conflict detection, squash merges, and Relay-style global ids.
- **REST** (`rest.ts`), **GraphQL** (`graphql.ts`, a small parser + executor with introspection),
  **MCP** (`mcp.ts`, six tools on the same store) all share the store, so an object created over
  one surface reads back over the others with the same ids.
- **Determinism**: no `Date.now()`, no `Math.random()`, no unseeded ids anywhere that reaches the
  export. Timestamps come from `MAKEFUN_TRIAL_NOW` plus a monotonic tick; request ids are a
  counter. Two runs of the sealed suite against fresh servers produce identical check details.

## Local verification

Against the kit's own sealed suite (`sdk/run.ts`, Node 22.20.0):

- **120/120 conformance checks pass** (git 30/30, repos 15/15, issues 15/15, pulls 20/20,
  protocol 5/5, GraphQL 20/20, MCP 15/15) — feature 600, agent 200.
- **Perf 164–171/200** across runs (push ~2.6×, clone ~1.4×, read ~2.6×, write ~3.6× faster than
  the house reference's calibration times), total **964–971/1000** on this VM.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above.
- `app.ts`: the HTTP server and routing.
- `store.ts`: the in-memory store, object model, diff/merge logic.
- `git.ts`: git smart HTTP (v2 + v0), packfile read/write.
- `rest.ts`: REST v3 handlers.
- `graphql.ts`: GraphQL parser, executor, introspection.
- `mcp.ts`: MCP (JSON-RPC 2.0) handlers.
- `util.ts`: deterministic clock, hashing, auth, small helpers.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

MIT licensed.

<sub>Entered on [make.fun](https://make.fun/?ref=7jv9haby&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
