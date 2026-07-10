# @decocms/typegen

Generate typed TypeScript clients for [Studio](https://github.com/decocms/mesh) Virtual MCPs.

## Usage

### 1. Generate a client

Connect to a Virtual MCP and write a typed `client.ts`:

```bash
bunx @decocms/typegen --mcp <virtual-mcp-id> --key <api-key> --output client.ts
```

| Flag | Env var | Default |
|------|---------|---------|
| `--mcp` | `STUDIO_MCP_ID` | **required** |
| `--key` | `STUDIO_API_KEY` | — |
| `--url` | `STUDIO_BASE_URL` | `https://studio.decocms.com` |
| `--output` | — | `client.ts` |
| `--schemas-dir` | — | — (skipped unless set) |

Pass `--schemas-dir <dir>` to also write one JSON Schema file per tool
(`<dir>/<TOOL>.json`, containing `{ name, description, inputSchema, outputSchema }`).
Handy for dropping a browsable tool catalog onto the filesystem — e.g. so an
agent can discover what's available without loading every schema into context.

> The legacy `MESH_API_KEY` / `MESH_BASE_URL` env vars are still honored as a
> fallback, so existing setups keep working.

### 2. Use the generated client

The generated `client.ts` looks like this:

```ts
// client.ts (auto-generated)
import { createMeshClient } from "@decocms/typegen";

export interface Tools {
  SEARCH: {
    input: { query: string; limit?: number };
    output: { results: string[] };
  };
}

export const client = createMeshClient<Tools>({
  mcpId: "vmc_abc123",
  apiKey: process.env.STUDIO_API_KEY ?? process.env.MESH_API_KEY,
  baseUrl: process.env.STUDIO_BASE_URL ?? process.env.MESH_BASE_URL,
});
```

Import and call it:

```ts
import { client } from "./client.js";

const { results } = await client.SEARCH({ query: "hello" });
```

Each method is fully typed — inputs and outputs match the tool's schema.

## Runtime API

```ts
import { createMeshClient } from "@decocms/typegen";

const client = createMeshClient<Tools>({
  mcpId: "vmc_abc123",   // Virtual MCP ID
  apiKey: "sk_...",      // Falls back to process.env.STUDIO_API_KEY
  baseUrl: "https://...", // Falls back to https://studio.decocms.com
});
```

- Connects lazily on first call
- Reuses the connection for subsequent calls
- Throws on tool errors with the error message from the server

## Calling tools from the CLI

Beyond code generation, the CLI can list and call tools directly — useful for
shell scripts and agents. `--mcp`/`--key`/`--url` fall back to
`STUDIO_MCP_ID`/`STUDIO_API_KEY`/`STUDIO_BASE_URL` (and the legacy `MESH_*`
names), so in an environment that exports those you can run these flagless:

```bash
# List available tools (name — first line of description)
bunx @decocms/typegen tools

# Print one tool's full definition (JSON Schema)
bunx @decocms/typegen tools SEARCH

# Call a tool; prints structuredContent as JSON
bunx @decocms/typegen call SEARCH '{"query":"hello"}'
```

`call` exits non-zero and prints the server's error message when a tool fails.

## Regenerating

Re-run the CLI whenever the Virtual MCP's tools change:

```bash
bunx @decocms/typegen --mcp vmc_abc123 --output client.ts
```
