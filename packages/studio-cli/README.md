# @decocms/studio-cli

The Studio commands an agent or a person runs from a shell: `auth`, `orgs`,
`tools`, and `api`.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/studio-cli` (`packages/studio-cli`) |
| Kind | Shared CLI command library |
| Runtime | Node.js 20+ and Bun |
| Distribution | Private workspace package; bundled into the `decocms` server CLI and the `decocms` binary of `@decocms/typegen` |

## Overview

The same commands ship in two places so an agent learns one vocabulary:

- the `decocms` npm package (the Studio server), for people and local agents;
- `@decocms/typegen`, which the Studio sandbox image installs, so a run's
  agent has `decocms` on its PATH.

The commands are shared; the credentials are not. A run acts with its own
org-bound key, and a person acts with their own login.

## Responsibilities

- Log in to a studio with OAuth 2.0 + PKCE, store the session per studio, and
  refresh it before it expires.
- Resolve which credential a command uses, in a fixed order.
- List, describe, and call tools: an org's builtin tools over REST, or a
  Virtual MCP's tools (a run's endpoint, or an agent with `--agent`) over MCP.
- Send authenticated requests to any Studio route (`api`) and list the user's
  organizations (`orgs`).

## Usage

```bash
decocms auth login                       # opens the browser
decocms auth whoami                      # which credential commands will use
decocms orgs                             # slug<TAB>name per organization
decocms tools list --org my-org thread
decocms tools call COLLECTION_THREADS_LIST --org my-org -d '{"limit":5}'
decocms tools list --org my-org --agent vir_123   # one agent's tools
decocms api "/api/my-org/fs/home/list?path="
```

Inside a Studio run, `decocms tools list|describe|call` need no flags: the run's
endpoint decides the tools. `decocms --help` lists every option.

Embed the commands in another CLI with `runStudioCli(args)`, which returns the
exit code, and `isStudioCliCommand(args[0])` to route to it.

## Architecture

`src/index.ts` parses flags and dispatches to `src/commands/`. Credentials come
from `src/lib/credentials.ts`, first match wins:

1. `--target <url>`: the login for that studio.
2. `STUDIO_API_KEY`, with `STUDIO_BASE_URL` (default `https://studio.decocms.com`).
3. `.deco/tools/.endpoint.json`, found by walking up from the working
   directory: the sandbox daemon writes the run's endpoint there.
4. The login from `decocms auth login`, stored as
   `session.<host>.json` under `--home`, `DATA_DIR`, `DECOCMS_HOME`, or `~/deco`.

`tools` reads that credential to pick a source: REST at `/api/:org/tools` for a
login or API key, or an MCP Streamable HTTP client for a run's endpoint or
`/api/:org/mcp/virtual-mcp/:id` with `--agent`. `api` and `orgs` need a login
or an API key; a run's key only covers the run's tools, so they refuse it.

## Development

```bash
bun run --cwd=packages/studio-cli check
bun run --cwd=packages/studio-cli test
```

The code runs under both Node (inside `@decocms/typegen`) and Bun (inside the
server), so it uses Node APIs only. Rebuild typegen to try the Node binary:

```bash
bun run --cwd=packages/typegen build
node packages/typegen/dist/studio.js auth whoami
```

## Boundaries

- The OAuth token never leaves its studio: `api` refuses paths that resolve to
  another origin, and the CLI never prints the token except through
  `auth token`.
- Session files and `.deco/tools/.endpoint.json` hold bearer credentials. They
  are written with mode 0600; do not print, commit, or copy them.
- A change here ships through `decocms`, `@decocms/typegen`, and the sandbox
  image; `scripts/release-changes.ts` bumps all three.

## Related documentation

- [`@decocms/typegen`](../typegen/README.md): the published package that
  carries the `decocms` binary into sandboxes.
- [`decocms-studio` skill](../../apps/api/plugin/skills/decocms-studio/SKILL.md):
  how agents use these commands.
- [`tool-scripting` skill](../sandbox/image/skills/tool-scripting/SKILL.md):
  bulk tool calls from inside a sandbox.
