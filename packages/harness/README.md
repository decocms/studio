# @decocms/harness

Provides the Decopilot agent harness plus the stream contracts Studio's API, web client, and sandbox share.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/harness` (`packages/harness`) |
| Kind | Agent runtime library |
| Runtime | Node.js 24+ |
| Distribution | Private workspace package |

## Overview

A harness turns one normalized conversation request into an asynchronous stream
of AI SDK `UIMessageChunk` values.

The package contains the Decopilot harness plus prompt, source-adapter,
stream-codec, title, heartbeat, and offload utilities. It is private because it
depends on Studio's private shared package and evolves with the API.

Decopilot is the only harness here, and `apps/api` is the only host that runs
one. The CLI harnesses (`claude-code`, `codex`) were removed once the desktop
link and the TypeScript sandbox daemon were deleted; the live CLI
implementation is Rust, in `apps/native/crates/harness`. What survives of them
here is `claude-code/model/agent-tiers.ts`, which the API and web client read
to build the model picker.

The package boundary now earns its keep for a different reason than
portability: `apps/web` and `packages/sandbox` are lint-barred from importing
`apps/api/src`, so the contracts all three share have to live outside the API.

## Responsibilities

- Define the portable `Harness`, `HarnessFactory`, and `HarnessStreamInput`
  contracts.
- Register and resolve harness factories by harness identifier.
- Run the native Decopilot agent loop.
- Normalize MCP, model, object-storage, and sandbox sources.
- Preserve resumable session metadata, usage, titles, liveness heartbeats, and
  stream framing across process boundaries.

## Usage

This is an internal workspace dependency. Consumers should use package exports,
not relative paths into `src/`.

```ts
import { decopilotHarnessFactory } from "@decocms/harness/decopilot/index";
import {
  getHarnessFactory,
  registerHarnessFactory,
} from "@decocms/harness/registry";

registerHarnessFactory(decopilotHarnessFactory);
const factory = getHarnessFactory("decopilot");
const harness = factory?.create(harnessContext);
```

Supported package exports:

| Import path | Surface |
| --- | --- |
| `@decocms/harness` | Portable types, registry helpers, and offload constants and envelope types |
| `@decocms/harness/types` | Harness contracts and the secret-model source helper |
| `@decocms/harness/registry` | Factory registration and lookup |
| `@decocms/harness/sources` | MCP, model, object-storage, and sandbox source adapters |
| `@decocms/harness/decopilot/*` | Agent-loop internals and built-in tools |
| `@decocms/harness/skills/skill-md` | Skill front-matter parsing |

`package.json`'s `exports` map lists every reachable path explicitly. There is
no wildcard: it used to end in `"./*"`, which made every file under `src/` look
like a public entry point and left knip unable to report anything in this
package as unused. Enumerating the paths is what makes dead code here visible.

**Adding a module that another workspace imports means adding its `exports`
entry too.** Skipping that step fails as `TS2307: Cannot find module` on `bun
run check` — the file exists, it just is not exported. Modules used only inside
this package need no entry; import them relatively.

Treat every subpath as an internal contract: the package is private.

## Architecture

`src/types.ts` defines the portable execution input and streaming output.
`src/registry.ts` stores factories rather than harness singletons so callers can
bind request-local tracing and provider dependencies.

`src/decopilot/` runs the native AI SDK agent loop and built-in tools, and is
roughly three quarters of the package. `src/sources.ts` opens in-process or
HTTP-backed dependencies without importing application code.

`apps/api` is the only host that registers a factory and runs a loop.
`apps/web` and `packages/sandbox` consume contracts only — harness types, the
stream and offload codecs, and a few tool/prompt constants.

## Development

Run commands from the repository root:

```bash
bun install
bun run --cwd=packages/harness check
bun run --cwd=packages/harness test
```

Run one focused test with:

```bash
bun test packages/harness/src/decopilot/conversation.test.ts
```

Tests include import-boundary guards, source adapters, prompt construction,
stream framing, and portable built-in tools.

## Boundaries

The package cannot import `@/` aliases, reach into any `apps/*` tree, or depend
on `@decocms/sandbox`; `src/no-cross-tree.test.ts` enforces that boundary. That
is what lets `apps/web` (barred from `apps/api/src` by
`plugins/ban-web-server-imports.js`) and `packages/sandbox` share these
contracts at all.

Anything `apps/web` imports must stay browser-safe: no `node:` builtins, no
server-only dependencies pulled in transitively.

Database access, authentication, tenant policy, HTTP routing, cluster-only
tools, and UI behavior stay in their owning applications. Request-local
application dependencies enter through factory construction or narrow source
interfaces, not through app imports.

Harness implementations own subprocess and stream cleanup. A provider created
for a turn must close on completion, failure, abort, or abandoned iteration.

## Related documentation

- [Studio agent runtimes](../../apps/docs/client/src/content/deco-studio/en/studio/agents.mdx)
- [Testing policy](../../TESTING.md)
- [Contribution guide](../../CONTRIBUTING.md)
