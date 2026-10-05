# @decocms/cli

The `decocms` command an agent or a person runs from a shell (`auth`, `orgs`,
`tools`, `api`, `typegen`) and `createStudioClient()`, the typed client that
generated code and scripts import.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/cli` (`packages/cli`) |
| Kind | Public CLI and client library |
| Runtime | Node.js 20+ and Bun |
| Distribution | Public npm package; `decocms` binary. Also bundled into the `decocms` server CLI and installed in the Studio sandbox image |

## Overview

One vocabulary everywhere an agent reaches Studio from a shell:

- people and local agents run `bunx @decocms/cli` (or the server package's
  `decocms`, which bundles the same commands);
- the Studio sandbox image installs this package from the same revision, so a
  run's agent has `decocms` on its PATH.

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
- Generate a typed TypeScript client for an agent's tools (`typegen`).
- Provide `createStudioClient()`, the lazy MCP client generated code calls.

## Usage

```bash
bunx @decocms/cli auth login             # opens the browser
decocms auth whoami                      # which credential commands will use
decocms orgs                             # slug<TAB>name per organization
decocms tools list --org my-org thread
decocms tools call COLLECTION_THREADS_LIST --org my-org -d '{"limit":5}'
decocms tools list --org my-org --agent vir_123   # one agent's tools
decocms api "/api/my-org/fs/home/list?path="
decocms typegen --org my-org --agent vir_123 --output client.ts
```

Inside a Studio run, `decocms tools list|describe|call` and `decocms typegen`
need no flags: the run's endpoint decides the tools. `decocms --help` lists
every option.

Call tools from a script, typed with a generated `client.ts` or untyped:

```ts
import { createStudioClient } from "@decocms/cli";

const client = createStudioClient(); // the sandbox endpoint, or mcpId + apiKey
const result = await client.SEARCH({ query: "Studio" });
await client.close();
```

Embed the commands in another CLI with `runStudioCli(args)`, which returns the
exit code, and `isStudioCliCommand(args[0])` to route to it; the server's
`apps/api/src/cli.ts` does this.

## Architecture

`src/index.ts` parses flags and dispatches to `src/commands/`. Credentials come
from `src/lib/credentials.ts`, first match wins:

1. `--target <url>`: the login for that studio.
2. `STUDIO_API_KEY`, with `STUDIO_BASE_URL` (default `https://studio.decocms.com`).
3. `.deco/tools/.endpoint.json`, found by walking up from the working
   directory: the sandbox daemon writes the run's endpoint there.
4. The login from `decocms auth login`, stored as
   `session.<host>.json` under `--home`, `DATA_DIR`, `DECOCMS_HOME`, or `~/deco`.

`tools` reads that credential to pick a source: REST at `/api/:org/tools` for
a login or API key, or an MCP Streamable HTTP client for a run's endpoint or
`/api/:org/mcp/virtual-mcp/:id` with `--agent`. `typegen` always uses MCP, the
same way, and `src/lib/codegen.ts` turns each tool's JSON Schemas into a
`Tools` type. `api` and `orgs` need a login or an API key; a run's key only
covers the run's tools, so they refuse it.

The package's export conditions send Bun and TypeScript to `src/` and plain
Node to the tsup build in `dist/`, which is also what the `decocms` binary runs.

## Development

```bash
bun run --cwd=packages/cli check
bun run --cwd=packages/cli test
```

The code runs under both Node (the published binary) and Bun (the server), so
it uses Node APIs only. Build and run the Node binary:

```bash
bun run --cwd=packages/cli build
node packages/cli/dist/bin.js auth whoami
```

## Boundaries

- The OAuth token never leaves its studio: `api` refuses paths that resolve to
  another origin, and the CLI never prints the token except through
  `auth token`.
- Session files and `.deco/tools/.endpoint.json` hold bearer credentials. They
  are written with mode 0600; do not print, commit, or copy them.
- Generated clients authenticate with `STUDIO_API_KEY` or the sandbox's
  endpoint file; they don't read the `decocms auth login` session.
- Generated types are a snapshot of the agent's tools. Rerun `decocms typegen`
  when they change; the runtime does not validate responses against them.
- A change here ships through npm, the `decocms` server CLI, and the sandbox
  image; `scripts/release-changes.ts` bumps all three.

## Related documentation

- [`decocms-studio` skill](../../apps/api/plugin/skills/decocms-studio/SKILL.md):
  how agents use these commands.
- [`tool-scripting` skill](../sandbox/image/skills/tool-scripting/SKILL.md):
  bulk tool calls from inside a sandbox.
