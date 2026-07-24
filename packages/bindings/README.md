# @decocms/bindings

Defines typed, reusable contracts for capabilities exposed through Model Context Protocol tools.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/bindings` (`packages/bindings`) |
| Kind | TypeScript contract library |
| Runtime | Node.js 24+ |
| Distribution | Public npm package |

## Overview

A binding is a list of MCP tool names paired with Zod input and output schemas.
It gives producers and consumers one shared description of a capability without
coupling either side to a Studio application.

The package includes the binding primitives, typed client adapters, connection
types, and well-known contracts for collections, language models, object
storage, MCP configuration, assistants, prompts, AI gateway billing, triggers,
brands, and event subscribers.

## Responsibilities

- Define `Binder` and `ToolBinder` contracts for required and optional tools.
- Check whether a tool list contains every required binding member.
- Produce typed clients for an existing MCP client or an MCP connection.
- Publish reusable Zod schemas and TypeScript types for well-known contracts.
- Define collection query, pagination, sorting, and CRUD shapes.

## Usage

Install the public package:

```bash
bun add @decocms/bindings
```

Define a binding and check whether an MCP tool list implements it:

```ts
import {
  createBindingChecker,
  type Binder,
} from "@decocms/bindings";
import { z } from "zod";

const SEARCH_BINDING = [
  {
    name: "SEARCH" as const,
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.object({ results: z.array(z.string()) }),
  },
  {
    name: "SEARCH_SUGGEST" as const,
    inputSchema: z.object({ prefix: z.string() }),
    outputSchema: z.object({ suggestions: z.array(z.string()) }),
    opt: true,
  },
] as const satisfies Binder;

const checker = createBindingChecker(SEARCH_BINDING);
const supported = checker.isImplementedBy([{ name: "SEARCH" }]);
```

Supported package exports:

| Import path | Surface |
| --- | --- |
| `@decocms/bindings` | Binding primitives plus event subscriber, trigger, object-storage, and brand exports |
| `@decocms/bindings/collections` | Collection schemas, factories, and types |
| `@decocms/bindings/llm` | Deprecated language-model binding |
| `@decocms/bindings/object-storage` | Object-storage binding |
| `@decocms/bindings/connection` | MCP connection descriptor types |
| `@decocms/bindings/client` | Typed MCP clients and HTTP transport |
| `@decocms/bindings/mcp` | MCP configuration binding |
| `@decocms/bindings/assistant` | Assistant collection binding |
| `@decocms/bindings/prompt` | Prompt schemas and types |
| `@decocms/bindings/ai-gateway` | AI gateway billing binding |
| `@decocms/bindings/trigger` | Trigger binding and typed client |
| `@decocms/bindings/brand` | Brand binding and typed client |

## Architecture

`src/core/binder.ts` owns the binding model, compatibility checker, and typed
client factory. `src/core/client/` adapts either a live MCP client or a
connection descriptor into callable, binding-shaped methods.

`src/well-known/` contains capability-specific schemas and tool lists. The
package export map exposes only the supported entry points listed above; the
root barrel intentionally re-exports only the most commonly shared contracts.

Collection bindings generate `COLLECTION_<NAME>_LIST` and
`COLLECTION_<NAME>_GET` as required tools. Unless `readOnly: true` is set, they
also describe optional create, update, and delete tools. The canonical base
entity schema includes identity, title, description, timestamps, and audit
fields.

## Development

Run commands from the repository root:

```bash
bun install
bun run --cwd=packages/bindings check
bun run --cwd=packages/bindings test
```

Run the focused MCP binding test with:

```bash
bun test packages/bindings/test/mcp.test.ts
```

The package publishes TypeScript source directly and has no separate build
script.

## Boundaries

This package owns capability contracts, not implementations. Database access,
authorization, HTTP route handling, Studio application state, and UI behavior
belong elsewhere.

Do not import unpublished files under `src/`; use a package export. Do not add
app aliases or reach into `apps/api` or `apps/web`.

`createBindingChecker` currently verifies required tool-name coverage, including
regular-expression names and optional entries. The schemas remain part of the
binding contract, but the checker does not currently perform structural schema
compatibility validation.

The `/llm` binding targets an older AI SDK provider abstraction and is
deprecated. New model integrations use native provider adapters instead of
extending that binding.

## Related documentation

- [Studio repository overview](../../README.md)
- [Contribution guide](../../CONTRIBUTING.md)
- [Testing policy](../../TESTING.md)
