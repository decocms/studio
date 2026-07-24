# @decocms/typegen

Generates typed Studio MCP clients, inspects remote tools, and calls them from a
Node.js command line.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/typegen` (`packages/typegen`) |
| Kind | Public typed-client generator and CLI |
| Runtime | Node.js 20+ |
| Distribution | Public npm package; `typegen` binary |

## Overview

`@decocms/typegen` connects to a Studio Virtual MCP, reads its tool schemas, and
generates a TypeScript client with one typed method per tool. The package also
provides a lazy runtime client and CLI commands for inspecting or invoking tools.

The generator converts MCP JSON Schemas with `json-schema-to-typescript` and
formats the emitted source with Prettier. Generated clients call the standard MCP
Streamable HTTP endpoint through `createStudioClient()`.

## Responsibilities

- Resolve a Virtual MCP endpoint from flags, environment variables, explicit
  options, or sandbox discovery.
- List remote MCP tools and their schemas.
- Generate typed input/output declarations and a configured client.
- Optionally materialize one JSON Schema document per tool.
- Provide a lazy, reusable typed client proxy.
- Expose CLI commands for tool discovery and direct invocation.
- Reconnect cleanly after failure or an explicit `close()`.

## Usage

Generate `client.ts` for a Virtual MCP:

```bash
bunx @decocms/typegen \
  --mcp my-virtual-mcp-id \
  --key "$STUDIO_API_KEY" \
  --output client.ts
```

The default command is `generate`, so no subcommand is required. The generated
module exports a `Tools` interface and a ready-to-use `client`:

```ts
import { client } from "./client";

const result = await client.SEARCH({
  query: "Studio architecture",
});

await client.close();
```

Use the runtime API directly when tool types already exist:

```ts
import { createStudioClient } from "@decocms/typegen";

interface Tools {
  SEARCH: {
    input: { query: string };
    output: { matches: Array<{ title: string; url: string }> };
  };
}

const client = createStudioClient<Tools>({
  mcpId: "my-virtual-mcp-id",
  apiKey: process.env.STUDIO_API_KEY,
});

const result = await client.SEARCH({ query: "typed MCP clients" });
await client.close();
```

Inspect tools without generating code:

```bash
bunx @decocms/typegen tools --mcp my-virtual-mcp-id --key "$STUDIO_API_KEY"
bunx @decocms/typegen tools SEARCH --mcp my-virtual-mcp-id --key "$STUDIO_API_KEY"
```

Call a tool and print its structured result:

```bash
bunx @decocms/typegen call SEARCH '{"query":"Studio"}' \
  --mcp my-virtual-mcp-id \
  --key "$STUDIO_API_KEY"
```

## Architecture

The package has three parts:

1. **CLI** — resolves connection settings, connects an MCP client, and dispatches
   the generate, tools, or call operation.
2. **Code generator** — converts each input and output JSON Schema to an inline
   TypeScript type, builds a `Tools` map, and formats the generated module.
3. **Runtime client** — creates a proxy whose property names are MCP tool names.
   The first call opens one shared connection; concurrent calls reuse the same
   connection promise.

`createStudioClient()` returns `result.structuredContent` for a successful call and
throws for an MCP tool error. A failed connection is removed from the cache so the
next call may retry. `close()` closes the current MCP client and resets the proxy;
the next tool call resolves its endpoint again and reconnects.

Inside a Studio sandbox, the daemon writes a pre-authenticated endpoint to
`.deco/tools/.endpoint.json`. Discovery walks upward from the current directory.
This lets scripts and CLI commands run without flags while still picking up
refreshed credentials after `close()`.

## Development

Run package checks and tests from the repository root:

```bash
bun run --cwd=packages/typegen check
bun run --cwd=packages/typegen test
```

Build the bundled ESM library, declarations, source maps, and CLI:

```bash
bun run --cwd=packages/typegen build
```

Run the CLI directly during development:

```bash
bun run --cwd=packages/typegen dev -- --mcp my-virtual-mcp-id
```

Format and lint repository changes before committing:

```bash
bun run fmt
bun run lint
```

## Boundaries

- Generated types are a snapshot of the remote tool list and JSON Schemas. Rerun
  the generator whenever that Virtual MCP contract changes.
- Type safety is compile-time only. The runtime returns MCP
  `structuredContent`; it does not validate the response against the generated
  output type.
- `.deco/tools/.endpoint.json` can contain authorization headers. Do not commit,
  print, share, or copy it outside its sandbox.
- Endpoint discovery checks that the file is parseable and contains a string URL.
  It exposes `expiresAt` metadata but does not enforce expiry; the remote endpoint
  remains the authority.
- The package is Node.js-only. Its CLI and discovery path use process and
  filesystem APIs and must not be imported into browser bundles.
- `--url` and `STUDIO_BASE_URL` identify the Studio base URL, not an arbitrary
  pre-authenticated endpoint. Library consumers use the `endpoint` option for a
  complete URL and headers.
- Treat generated source as an artifact. Regenerate it instead of manually
  editing schema-derived types.

## CLI reference

### Generate

```text
typegen [--mcp ID] [--key KEY] [--url BASE_URL]
        [--output FILE] [--schemas-dir DIRECTORY]
```

| Flag | Default | Purpose |
| --- | --- | --- |
| `--mcp` | `STUDIO_MCP_ID` | Virtual MCP identifier |
| `--key` | `STUDIO_API_KEY` | Studio API key sent as a Bearer token |
| `--url` | `STUDIO_BASE_URL` or `https://studio.decocms.com` | Studio base URL |
| `--output` | `client.ts` | Generated TypeScript module |
| `--schemas-dir` | Not written | Directory for per-tool JSON Schema files |

### Inspect tools

```text
typegen tools [TOOL_NAME] [connection flags]
```

Without a name, the command prints the tool list and first description line. With
a name, it prints that complete MCP tool definition as JSON.

### Call a tool

```text
typegen call TOOL_NAME [JSON_INPUT] [connection flags]
```

The input defaults to `{}`. The command prints structured output as formatted JSON
and exits unsuccessfully when the MCP reports a tool error.

## Configuration precedence

For CLI commands, connection flags take precedence over `STUDIO_MCP_ID`,
`STUDIO_API_KEY`, and `STUDIO_BASE_URL`. When no MCP ID is configured, the CLI
attempts sandbox endpoint discovery.

`createStudioClient()` uses an explicit `endpoint` first. It otherwise combines
`mcpId`, `apiKey`, and `baseUrl`, or discovers the sandbox endpoint when
credentials are not supplied. The canonical configuration names use `STUDIO_*`.
Legacy `MESH_MCP_ID`, `MESH_API_KEY`, and `MESH_BASE_URL` remain fallback aliases
for compatibility.

## Public API

The package exposes one root library entry point:

| Export | Purpose |
| --- | --- |
| `createStudioClient` | Create the lazy typed MCP client proxy |
| `discoverEndpoint` | Find and parse `.deco/tools/.endpoint.json` |
| `ToolMap` | Generic map from tool names to input/output types |
| `StudioClientInstance` | Typed tool methods |
| `StudioClient` | Typed tool methods plus `close()` |
| `StudioClientOptions` | Endpoint, Virtual MCP, API key, and base URL options |
| `DiscoveredEndpoint` | Shape returned by endpoint discovery |
| `createMeshClient` and `MeshClient*` | Deprecated compatibility aliases |

`generateClientCode()` and schema conversion helpers are internal to the CLI and
are not exported from the package root.

## Related documentation

- [Sandbox transport and endpoint discovery](../sandbox/README.md)
- [Repository guidelines](../../AGENTS.md)
- [Testing strategy](../../TESTING.md)
