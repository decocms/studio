# @decocms/harness

Provides portable agent harnesses and stream contracts shared by Studio execution environments.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/harness` (`packages/harness`) |
| Kind | Agent runtime library |
| Runtime | Node.js 24+ |
| Distribution | Private workspace package |

## Overview

A harness turns one normalized conversation request into an asynchronous stream
of AI SDK `UIMessageChunk` values. Studio uses the same contracts for in-process
API execution and desktop sandbox execution.

The package contains Decopilot, Claude Code, and Codex harnesses plus portable
prompt, source-adapter, stream-codec, title, heartbeat, and offload utilities.
It is private because it depends on Studio's private shared package and evolves
with the API and sandbox.

## Responsibilities

- Define the portable `Harness`, `HarnessFactory`, and `HarnessStreamInput`
  contracts.
- Register and resolve harness factories by harness identifier.
- Run native Decopilot agent loops and CLI-backed Claude Code or Codex loops.
- Normalize MCP, model, object-storage, and sandbox sources.
- Preserve resumable session metadata, usage, titles, liveness heartbeats, and
  stream framing across process boundaries.

## Usage

This is an internal workspace dependency. Consumers should use package exports,
not relative paths into `src/`.

```ts
import { codexHarnessFactory } from "@decocms/harness/codex";
import {
  getHarnessFactory,
  registerHarnessFactory,
} from "@decocms/harness/registry";

registerHarnessFactory(codexHarnessFactory);
const factory = getHarnessFactory("codex");
const harness = factory?.create(harnessContext);
```

Supported package exports:

| Import path | Surface |
| --- | --- |
| `@decocms/harness` | Portable types, registry helpers, and offload constants and envelope types |
| `@decocms/harness/types` | Harness contracts and the secret-model source helper |
| `@decocms/harness/registry` | Factory registration and lookup |
| `@decocms/harness/claude-code` | Claude Code harness |
| `@decocms/harness/codex` | Codex harness |
| `@decocms/harness/sources` | MCP, model, object-storage, and sandbox source adapters |
| `@decocms/harness/<module>` | A top-level `src/<module>.ts` or `src/<module>/index.ts` entry |

The wildcard export also permits nested paths that resolve to real source
files, such as `@decocms/harness/decopilot/mode-config`. Treat those paths as
internal contracts because the package is private.

## Architecture

`src/types.ts` defines the portable execution input and streaming output.
`src/registry.ts` stores factories rather than harness singletons so callers can
bind request-local tracing and provider dependencies.

`src/decopilot/` runs the native AI SDK agent loop and built-in tools.
`src/claude-code/` and `src/codex/` adapt their respective CLI providers,
including session resume and child-process cleanup. `src/sources.ts` opens
in-process or HTTP-backed dependencies without importing application code.

The API registers all available factories for cloud execution. The sandbox
daemon registers the CLI factories available on the linked machine. Both
consume the same stream and offload codecs.

## Development

Run commands from the repository root:

```bash
bun install
bun run --cwd=packages/harness check
bun run --cwd=packages/harness test
```

Run one focused test with:

```bash
bun test packages/harness/src/codex/index.test.ts
```

Tests include import-boundary guards, harness conformance, provider cleanup,
stream metadata, source adapters, prompt construction, and portable built-in
tools.

## Boundaries

The package must remain portable between the API and sandbox daemon. It cannot
import `@/` aliases, reach into any `apps/*` tree, or depend on
`@decocms/sandbox`; `src/no-cross-tree.test.ts` enforces that boundary.

CLI harnesses must not import the Decopilot namespace. Shared CLI behavior
belongs in top-level modules so Claude Code and Codex do not pull the native
agent loop into their execution path.

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
