# Design: `@decocms/typegen` — MCP TypeScript Client Generator

**Date:** 2026-02-25
**Status:** Approved

## Overview

A new package `packages/typegen` published as `@decocms/typegen` with two purposes:

1. **CLI bin** (dev time) — connects to a Virtual MCP, introspects its tools, and generates a typed TypeScript client file
2. **Runtime library** (ships with user app) — exports `createMeshClient<T>()` used by the generated file

## Usage

```bash
bunx @decocms/typegen --mcp <virtual-mcp-id> --key <mesh-api-key> --output client.ts
```

## Package Structure

```
packages/typegen/
  src/
    cli.ts        # bin entry point — parses args, orchestrates codegen
    codegen.ts    # connects to MCP, lists tools, generates TypeScript
    runtime.ts    # createMeshClient factory + Proxy + types
    index.ts      # library exports (createMeshClient, MeshClientInstance)
  package.json
  tsup.config.ts
  tsconfig.json
```

**Name:** `@decocms/typegen`
**Bin:** `typegen` (invoked via `bunx @decocms/typegen`)

## Dependencies

Bundled inside `@decocms/typegen` — users only install this one package:

- `@modelcontextprotocol/sdk` — CLI uses it to connect + list tools; runtime uses it for `createMeshClient`
- `json-schema-to-typescript` — converts JSON Schema → TypeScript interfaces during codegen

## Generated Output

```typescript
// client.ts (generated)
import { createMeshClient } from "@decocms/typegen";

export interface Tools {
  SEARCH_TOOL: {
    input: { query: string; limit?: number };
    output: { results: Array<{ id: string; title: string }> };
  };
  SUBMIT_FORM: {
    input: { name: string; data: Record<string, unknown> };
    output: { id: string; status: "created" };
  };
}

export const client = createMeshClient<Tools>({
  mcpId: "vmc_abc123",
  apiKey: process.env.MESH_API_KEY,
  baseUrl: process.env.MESH_BASE_URL,
});
```

Callers use:

```typescript
import { client } from "./client";

const result = await client.SEARCH_TOOL({ query: "hello", limit: 10 });
// result is typed: { results: Array<{ id: string; title: string }> }
```

## CLI Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--mcp` | yes | — | Virtual MCP ID |
| `--key` | no | `MESH_API_KEY` env var | Mesh API key |
| `--url` | no | `https://mesh-admin.decocms.com` | Mesh base URL |
| `--output` | no | `client.ts` | Output file path |

## Codegen Logic (`codegen.ts`)

1. Connect to `/mcp/virtual-mcp/:mcpId` using MCP SDK `Client` + `StreamableHTTPClientTransport` with `Authorization: Bearer <apiKey>`
2. Call `client.listTools()` — each tool has `inputSchema` (JSON Schema) and optionally `outputSchema` (supported in MCP protocol; Mesh's `defineTool` populates it)
3. For each tool:
   - Convert `inputSchema` → TypeScript via `json-schema-to-typescript` → `input` type
   - Convert `outputSchema` → TypeScript if present; otherwise fall back to `unknown` → `output` type
4. Assemble the `Tools` interface and `createMeshClient<Tools>({...})` call
5. Format with Prettier
6. Write to `--output`

## Runtime (`runtime.ts`)

```typescript
type ToolMap = Record<string, { input: unknown; output: unknown }>;

export type MeshClientInstance<T extends ToolMap> = {
  [K in keyof T]: (input: T[K]["input"]) => Promise<T[K]["output"]>;
};

export interface MeshClientOptions {
  mcpId: string;
  apiKey?: string;   // falls back to process.env.MESH_API_KEY
  baseUrl?: string;  // falls back to https://mesh-admin.decocms.com
}

export function createMeshClient<T extends ToolMap>(
  opts: MeshClientOptions
): MeshClientInstance<T>;
```

Implementation:
- Lazy-connects on the first tool call using MCP SDK `Client` + `StreamableHTTPClientTransport`
- Caches the connection — subsequent calls on the same `client` instance reuse it
- Returns a `Proxy` that traps property access: `client.TOOL_NAME(input)` → `mcpClient.callTool({ name: "TOOL_NAME", arguments: input })` → `result.structuredContent`
- Throws if `result.isError` is true, with the error text from `result.content`

## Error Handling

- CLI: prints clear error + exits with code 1 if connection fails, auth fails, or MCP not found
- Runtime: throws `MeshToolError` with `toolName` and message on tool call failure

## Build

Uses `tsup` (same pattern as `packages/cli`):
- Entry points: `src/cli.ts` (bin) + `src/index.ts` (library)
- Format: ESM
- Bundle: true (includes SDK + json-schema-to-typescript so users don't install separately)
