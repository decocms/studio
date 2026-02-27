# @decocms/typegen

Generate typed TypeScript clients for [Mesh](https://github.com/decocms/mesh) Virtual MCPs.

## Usage

### 1. Generate a client

Connect to a Virtual MCP and write a typed `client.ts`:

```bash
bunx @decocms/typegen --mcp <virtual-mcp-id> --key <api-key> --output client.ts
```

| Flag | Env var | Default |
|------|---------|---------|
| `--mcp` | — | **required** |
| `--key` | `MESH_API_KEY` | — |
| `--url` | `MESH_BASE_URL` | `https://studio.decocms.com` |
| `--output` | — | `client.ts` |

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
  apiKey: process.env.MESH_API_KEY,
  baseUrl: process.env.MESH_BASE_URL,
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
  apiKey: "sk_...",      // Falls back to process.env.MESH_API_KEY
  baseUrl: "https://...", // Falls back to https://studio.decocms.com
});
```

- Connects lazily on first call
- Reuses the connection for subsequent calls
- Throws on tool errors with the error message from the server

## Regenerating

Re-run the CLI whenever the Virtual MCP's tools change:

```bash
bunx @decocms/typegen --mcp vmc_abc123 --output client.ts
```
