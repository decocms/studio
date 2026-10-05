# Proposal: one Studio CLI for local agents and sandboxed runs

Status: proposal, for discussion. Nothing here is implemented.

## Problem

Agents reach Studio from a shell in two places, through two CLIs that do the
same thing under different names:

| | Local machine | Studio sandbox |
| --- | --- | --- |
| CLI | `decocms` (the `decocms` npm package) | `typegen` (`@decocms/typegen`) |
| Credential | the user's OAuth session from `decocms auth login`, refreshed by the CLI | the run's token in `.deco/tools/.endpoint.json`, written and refreshed by the daemon |
| List tools | `decocms tools list --org <slug>` | `typegen tools` |
| Call a tool | `decocms tools call NAME --org <slug> -d '{...}'` | `typegen call NAME '{...}'` |
| Surface | the org's builtin tools over `/api/:org/tools`, plus any route via `decocms api` | the agent's Virtual MCP: its granted tools, connection tools included |
| Skill | `decocms-studio` (plugin in `apps/api/plugin`) | `tool-scripting` (sandbox image) |

An agent that learns one cannot use the other, and two skills teach nearly the
same thing. The two can't simply merge into the existing `decocms` package:
it is the whole Studio server (about 104 MB and 9,000 files on npm), while the
sandbox image installs `@decocms/typegen` (about 64 KB) from the same revision.

The credentials are different on purpose and should stay that way. A run acts
with an org-bound API key whose allowlist is exactly the tools the run mounts
(`runKeyPermissions` in `apps/api/src/harnesses/sandbox-dispatch-client.ts`),
and its actions are attributed to the run; it must never hold a user's login.
Locally, the person acts with their own permissions.

## Proposal

### One light package owns the client commands

Move the client-side commands into a small package. It could be
`@decocms/typegen` renamed and grown, or a new `@decocms/cli`; see the open
questions.

- `auth login | whoami | token | logout`, `api`, `tools list | describe | call`,
  `orgs`: today in `apps/api/src/cli/commands`.
- Typed client generation and `createStudioClient()`: today in `@decocms/typegen`.

The package declares a `decocms` bin. The server package depends on it and
forwards these subcommands, so `bunx decocms tools ...` keeps working
unchanged. The sandbox image installs the light package instead of `typegen`,
so `decocms tools call` exists inside runs too.

### One credential chain, the same everywhere

Every command resolves its credential in this order and stops at the first hit:

1. Explicit flags or env: `--key` / `STUDIO_API_KEY`, `--url` / `STUDIO_BASE_URL`.
2. The sandbox endpoint file: `.deco/tools/.endpoint.json`, found by walking up
   from the working directory, as `typegen` does today.
3. The user session from `decocms auth login`.

`decocms auth whoami` reports which one is in use ("run endpoint for agent
`vir_…`" or "logged in as …"), so an agent can tell where it is.

### The target follows the credential

- **Run endpoint:** `tools` talks MCP to the run's Virtual MCP. `--org` is not
  needed and is rejected when it disagrees with the endpoint.
- **User session:** `tools --org <slug>` keeps calling the org's builtin tools
  over REST. A new `--agent <vir_id>` targets that agent's Virtual MCP at
  `/api/:org/mcp/virtual-mcp/:id`, which already accepts the user's OAuth
  token, so a person can reproduce locally exactly what a run sees.
- `api` and `orgs` need a user session. A run key's allowlist covers only the
  run's tools, so REST routes outside it deny the key anyway; with only a run
  endpoint these commands fail early with a message saying that.

### What stays and what goes

- The typed client generator and `createStudioClient()` keep their API.
  Generated clients and scripts in existing repos keep working.
- `typegen tools` and `typegen call` stay as aliases for one release, printing
  a pointer to `decocms tools`, then go away.
- The `tool-scripting` sandbox skill keeps its bulk-scripting section and uses
  `decocms tools` for one-off calls. The `decocms-studio` skill describes the
  run endpoint as one more credential source, so one skill serves both places.

## Rollout

1. Extract the commands into the light package and make the server package
   forward to it. Behavior doesn't change. Today's CLI tests move with the code.
2. Add the run-endpoint credential source and `--agent`. Unit tests cover the
   resolution order; e2e covers `--agent` with a real OAuth token.
3. Ship the light package in the sandbox image behind its own default-off
   flag, since image contents are on the run boot path. Keep `typegen`
   installed alongside it until the flag is on everywhere.
4. Update both skills, then remove the `typegen tools/call` aliases.

## Open questions

- **Package name:** grow `@decocms/typegen` (no new package to publish, but the
  name stops fitting) or publish `@decocms/cli` and keep `typegen` for codegen
  only?
- **`api` inside runs:** should a run reach REST-only routes (the org
  filesystem, thread outputs) through its key? Runs already see the org
  filesystem through mounts, and widening the key's allowlist is a server-side
  decision; this proposal leaves it out.
- **Concurrent runs in one sandbox:** `.deco/tools/.endpoint.json` has one
  value per workspace (see `packages/sandbox/run-attachment.md`). Resolving the
  credential from it inherits that last-writer-wins risk; it needs to be
  settled before step 3.
