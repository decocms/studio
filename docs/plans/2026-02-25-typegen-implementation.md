# `@decocms/typegen` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a new `packages/typegen` package that generates a typed TypeScript MCP client and exports a `createMeshClient<T>()` runtime factory.

**Architecture:** A dual-purpose package — a CLI bin (`bunx @decocms/typegen`) that connects to a Virtual MCP via the MCP SDK, introspects its tools, and writes a generated `client.ts`; plus a runtime export (`createMeshClient`) that returns a Proxy typed to the generated `Tools` interface. The MCP SDK and `json-schema-to-typescript` are listed as direct dependencies so `npm install @decocms/typegen` brings everything.

**Tech Stack:** TypeScript, Bun test runner, tsup (ESM bundle), `@modelcontextprotocol/sdk@1.26.0`, `json-schema-to-typescript`, Prettier (for formatting generated output)

---

## Context: Relevant Files to Read First

Before starting, read these files to understand patterns used in the repo:

- `packages/cli/package.json` — package.json shape, dep versions, bin setup
- `packages/cli/tsup.config.ts` — tsup config pattern (external deps, ESM, splitting)
- `packages/cli/tsconfig.json` — tsconfig extends pattern
- `packages/cli/src/lib/mcp.ts` — how MCP SDK Client is used (StreamableHTTPClientTransport, connect, callTool)
- `tsconfig.json` (root) — root tsconfig that all packages extend

---

## Task 1: Scaffold package files

**Files:**
- Create: `packages/typegen/package.json`
- Create: `packages/typegen/tsconfig.json`
- Create: `packages/typegen/tsup.config.ts`

**Step 1: Create `packages/typegen/package.json`**

```json
{
  "name": "@decocms/typegen",
  "version": "0.1.0",
  "description": "Generate typed TypeScript clients for Mesh Virtual MCPs",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "typegen": "./dist/cli.js"
  },
  "files": ["dist/**/*"],
  "scripts": {
    "build": "tsup",
    "dev": "tsx src/cli.ts",
    "check": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.26.0",
    "json-schema-to-typescript": "^15.0.4",
    "prettier": "^3.6.2"
  },
  "devDependencies": {
    "@types/node": "^24.6.2",
    "tsup": "^8.5.0",
    "tsx": "^4.7.1",
    "typescript": "^5.9.3"
  },
  "engines": { "node": ">=20.0.0" },
  "publishConfig": { "access": "public" }
}
```

**Step 2: Create `packages/typegen/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "noEmit": false,
    "allowImportingTsExtensions": false,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Create `packages/typegen/tsup.config.ts`**

```typescript
import { defineConfig, type Options } from "tsup";

const config: Options = {
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  target: "es2022",
  bundle: true,
  sourcemap: true,
  clean: true,
  dts: true,
  splitting: true,
  treeshake: true,
  shims: true,
  external: [
    "node:*",
    "@modelcontextprotocol/sdk",
    "json-schema-to-typescript",
    "prettier",
  ],
};

export default defineConfig(config);
```

**Step 4: Install deps**

```bash
bun install
```

Expected: deps resolved, `node_modules` updated.

**Step 5: Commit**

```bash
git add packages/typegen/
git commit -m "feat(typegen): scaffold package structure"
```

---

## Task 2: Runtime types

**Files:**
- Create: `packages/typegen/src/index.ts`

**Step 1: Create `packages/typegen/src/index.ts`**

This file exports the public API — types and the runtime factory. The implementation comes in Task 3.

```typescript
export type ToolMap = Record<string, { input: unknown; output: unknown }>;

export type MeshClientInstance<T extends ToolMap> = {
  [K in keyof T]: (input: T[K]["input"]) => Promise<T[K]["output"]>;
};

export interface MeshClientOptions {
  mcpId: string;
  /** Falls back to process.env.MESH_API_KEY */
  apiKey?: string;
  /** Falls back to https://mesh-admin.decocms.com */
  baseUrl?: string;
}

export { createMeshClient } from "./runtime.js";
```

**Step 2: Commit**

```bash
git add packages/typegen/src/index.ts
git commit -m "feat(typegen): add public types"
```

---

## Task 3: Runtime — `createMeshClient`

**Files:**
- Create: `packages/typegen/src/runtime.ts`
- Create: `packages/typegen/src/runtime.test.ts`

**Step 1: Write the failing test**

Create `packages/typegen/src/runtime.test.ts`:

```typescript
import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock the MCP SDK before importing runtime
const mockCallTool = mock(async ({ name, arguments: args }: { name: string; arguments: unknown }) => ({
  isError: false,
  structuredContent: { tool: name, args },
}));

const mockConnect = mock(async () => {});

const MockClient = mock(function () {
  return { callTool: mockCallTool, connect: mockConnect };
});

const MockTransport = mock(function () {});

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: MockClient,
}));

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockTransport,
}));

// Import AFTER mocking
const { createMeshClient } = await import("./runtime.js");

describe("createMeshClient", () => {
  beforeEach(() => {
    mockCallTool.mockClear();
    mockConnect.mockClear();
    MockClient.mockClear();
    MockTransport.mockClear();
  });

  test("returns an object with callable tool methods", async () => {
    type Tools = {
      MY_TOOL: { input: { id: string }; output: { name: string } };
    };

    const client = createMeshClient<Tools>({
      mcpId: "vmc_test",
      apiKey: "sk_test",
    });

    const result = await client.MY_TOOL({ id: "123" });

    expect(result).toEqual({ tool: "MY_TOOL", args: { id: "123" } });
    expect(mockCallTool).toHaveBeenCalledWith({
      name: "MY_TOOL",
      arguments: { id: "123" },
    });
  });

  test("lazy-connects on first call", async () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };

    const client = createMeshClient<Tools>({ mcpId: "vmc_test", apiKey: "sk" });

    expect(mockConnect).not.toHaveBeenCalled();

    await client.TOOL({});

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  test("reuses connection on subsequent calls", async () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };

    const client = createMeshClient<Tools>({ mcpId: "vmc_test", apiKey: "sk" });

    await client.TOOL({});
    await client.TOOL({});
    await client.TOOL({});

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  test("throws on isError response", async () => {
    mockCallTool.mockResolvedValueOnce({
      isError: true,
      content: [{ text: "Tool failed: bad input" }],
    });

    type Tools = { FAIL_TOOL: { input: Record<string, never>; output: unknown } };
    const client = createMeshClient<Tools>({ mcpId: "vmc_test", apiKey: "sk" });

    await expect(client.FAIL_TOOL({})).rejects.toThrow("Tool failed: bad input");
  });

  test("builds URL with correct mcpId and baseUrl", async () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };

    createMeshClient<Tools>({
      mcpId: "vmc_abc123",
      apiKey: "sk_key",
      baseUrl: "https://custom.example.com",
    });

    // Transport is constructed lazily, so call a tool to trigger connect
    const client = createMeshClient<Tools>({
      mcpId: "vmc_abc123",
      apiKey: "sk_key",
      baseUrl: "https://custom.example.com",
    });

    await client.TOOL({});

    const transportArg = MockTransport.mock.calls[0][0] as URL;
    expect(transportArg.toString()).toBe(
      "https://custom.example.com/mcp/virtual-mcp/vmc_abc123"
    );
  });

  test("defaults baseUrl to https://mesh-admin.decocms.com", async () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };
    const client = createMeshClient<Tools>({ mcpId: "vmc_abc", apiKey: "sk" });

    await client.TOOL({});

    const transportArg = MockTransport.mock.calls[0][0] as URL;
    expect(transportArg.toString()).toBe(
      "https://mesh-admin.decocms.com/mcp/virtual-mcp/vmc_abc"
    );
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test packages/typegen/src/runtime.test.ts
```

Expected: FAIL — `./runtime.js` module not found.

**Step 3: Write `packages/typegen/src/runtime.ts`**

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { MeshClientInstance, MeshClientOptions, ToolMap } from "./index.js";

const DEFAULT_BASE_URL = "https://mesh-admin.decocms.com";

export function createMeshClient<T extends ToolMap>(
  opts: MeshClientOptions,
): MeshClientInstance<T> {
  let mcpClient: Client | null = null;

  async function getClient(): Promise<Client> {
    if (mcpClient) return mcpClient;

    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    const apiKey = opts.apiKey ?? process.env.MESH_API_KEY;
    const url = new URL(`/mcp/virtual-mcp/${opts.mcpId}`, baseUrl);

    const client = new Client({ name: "@decocms/typegen", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        },
      }),
    );

    mcpClient = client;
    return client;
  }

  return new Proxy({} as MeshClientInstance<T>, {
    get(_target, toolName: string) {
      return async (input: unknown) => {
        const client = await getClient();
        const result = await client.callTool({
          name: toolName,
          arguments: input as Record<string, unknown>,
        });

        if (result.isError) {
          const message = Array.isArray(result.content)
            ? result.content.map((c) => ("text" in c ? c.text : "")).join(" ")
            : "Tool call failed";
          throw new Error(message);
        }

        return result.structuredContent;
      };
    },
  });
}
```

**Step 4: Run tests to verify they pass**

```bash
bun test packages/typegen/src/runtime.test.ts
```

Expected: all 5 tests PASS.

**Step 5: Commit**

```bash
git add packages/typegen/src/runtime.ts packages/typegen/src/runtime.test.ts
git commit -m "feat(typegen): add createMeshClient runtime with Proxy"
```

---

## Task 4: Codegen — schema-to-TypeScript conversion

**Files:**
- Create: `packages/typegen/src/codegen.ts`
- Create: `packages/typegen/src/codegen.test.ts`

**Step 1: Write the failing test**

Create `packages/typegen/src/codegen.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { generateClientCode } from "./codegen.js";

describe("generateClientCode", () => {
  test("generates Tools interface with input and output types", async () => {
    const output = await generateClientCode({
      mcpId: "vmc_abc123",
      tools: [
        {
          name: "SEARCH",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              limit: { type: "number" },
            },
            required: ["query"],
          },
          outputSchema: {
            type: "object",
            properties: {
              results: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["results"],
          },
        },
      ],
    });

    // Must export Tools interface
    expect(output).toContain("export interface Tools");
    // Must have the tool key
    expect(output).toContain("SEARCH:");
    // Must have input/output subkeys
    expect(output).toContain("input:");
    expect(output).toContain("output:");
    // Must import createMeshClient
    expect(output).toContain('from "@decocms/typegen"');
    // Must call createMeshClient with the mcpId
    expect(output).toContain("vmc_abc123");
    expect(output).toContain("createMeshClient<Tools>");
  });

  test("uses unknown for missing outputSchema", async () => {
    const output = await generateClientCode({
      mcpId: "vmc_test",
      tools: [
        {
          name: "NO_OUTPUT",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      ],
    });

    expect(output).toContain("output: unknown");
  });

  test("handles multiple tools", async () => {
    const output = await generateClientCode({
      mcpId: "vmc_multi",
      tools: [
        {
          name: "TOOL_A",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
          name: "TOOL_B",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });

    expect(output).toContain("TOOL_A:");
    expect(output).toContain("TOOL_B:");
  });

  test("exports a client const", async () => {
    const output = await generateClientCode({
      mcpId: "vmc_test",
      tools: [],
    });

    expect(output).toContain("export const client =");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test packages/typegen/src/codegen.test.ts
```

Expected: FAIL — `./codegen.js` not found.

**Step 3: Write `packages/typegen/src/codegen.ts`**

```typescript
import { compile } from "json-schema-to-typescript";
import { format } from "prettier";

export interface ToolDefinition {
  name: string;
  inputSchema: object;
  outputSchema?: object;
}

export interface GenerateOptions {
  mcpId: string;
  tools: ToolDefinition[];
}

const BANNER = `// This file was auto-generated by @decocms/typegen. Do not edit manually.
// Regenerate with: bunx @decocms/typegen --mcp <id> --key <key> --output <file>
`;

const PRETTIER_CONFIG = {
  parser: "typescript" as const,
  printWidth: 80,
  singleQuote: false,
  trailingComma: "all" as const,
  semi: true,
};

async function schemaToTs(
  schema: object,
  typeName: string,
): Promise<string> {
  const raw = await compile(schema as never, typeName, {
    bannerComment: "",
    additionalProperties: false,
  });
  // compile() emits `export interface TypeName { ... }` or `export type TypeName = ...`
  // We only want the body, so strip the export declaration wrapper
  return raw
    .replace(/^export\s+(interface|type)\s+\S+\s*(=\s*)?/m, "")
    .replace(/;\s*$/, "")
    .trim();
}

export async function generateClientCode(
  opts: GenerateOptions,
): Promise<string> {
  const { mcpId, tools } = opts;

  const toolEntries: string[] = [];

  for (const tool of tools) {
    const inputType = await schemaToTs(tool.inputSchema, `${tool.name}Input`);
    const outputType = tool.outputSchema
      ? await schemaToTs(tool.outputSchema, `${tool.name}Output`)
      : "unknown";

    toolEntries.push(
      `  ${tool.name}: {\n    input: ${inputType};\n    output: ${outputType};\n  };`,
    );
  }

  const toolsInterface =
    tools.length === 0
      ? "export interface Tools {}"
      : `export interface Tools {\n${toolEntries.join("\n")}\n}`;

  const code = `${BANNER}
import { createMeshClient } from "@decocms/typegen";

${toolsInterface}

export const client = createMeshClient<Tools>({
  mcpId: "${mcpId}",
  apiKey: process.env.MESH_API_KEY,
  baseUrl: process.env.MESH_BASE_URL,
});
`;

  return format(code, PRETTIER_CONFIG);
}
```

**Step 4: Run tests to verify they pass**

```bash
bun test packages/typegen/src/codegen.test.ts
```

Expected: all 4 tests PASS.

**Step 5: Commit**

```bash
git add packages/typegen/src/codegen.ts packages/typegen/src/codegen.test.ts
git commit -m "feat(typegen): add codegen — schema to TypeScript client"
```

---

## Task 5: CLI entry point

**Files:**
- Create: `packages/typegen/src/cli.ts`

No unit tests here — the CLI is a thin orchestration layer over already-tested modules. Manual smoke test at the end.

**Step 1: Create `packages/typegen/src/cli.ts`**

```typescript
#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { generateClientCode } from "./codegen.js";

const DEFAULT_BASE_URL = "https://mesh-admin.decocms.com";

function parseArgs(argv: string[]): {
  mcpId: string;
  apiKey: string | undefined;
  baseUrl: string;
  output: string;
} {
  const args = argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  const mcpId = get("--mcp");
  if (!mcpId) {
    console.error("Error: --mcp <virtual-mcp-id> is required");
    process.exit(1);
  }

  return {
    mcpId,
    apiKey: get("--key") ?? process.env.MESH_API_KEY,
    baseUrl: get("--url") ?? process.env.MESH_BASE_URL ?? DEFAULT_BASE_URL,
    output: get("--output") ?? "client.ts",
  };
}

async function main() {
  const { mcpId, apiKey, baseUrl, output } = parseArgs(process.argv);

  console.log(`Connecting to Virtual MCP: ${mcpId}`);

  const url = new URL(`/mcp/virtual-mcp/${mcpId}`, baseUrl);
  const client = new Client({ name: "@decocms/typegen", version: "1.0.0" });

  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        },
      }),
    );
  } catch (err) {
    console.error(
      `Error: Failed to connect to ${url}\n${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const { tools } = await client.listTools();

  console.log(`Found ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ") || "(none)"}`);

  const code = await generateClientCode({
    mcpId,
    tools: tools.map((t) => ({
      name: t.name,
      inputSchema: t.inputSchema as object,
      outputSchema: (t as { outputSchema?: object }).outputSchema,
    })),
  });

  await writeFile(output, code, "utf-8");
  console.log(`Generated: ${output}`);

  await client.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

**Step 2: Commit**

```bash
git add packages/typegen/src/cli.ts
git commit -m "feat(typegen): add CLI entry point"
```

---

## Task 6: Build and verify

**Step 1: Run type check**

```bash
bun run --cwd=packages/typegen check
```

Expected: no TypeScript errors.

**Step 2: Run all typegen tests**

```bash
bun test packages/typegen/
```

Expected: all tests PASS.

**Step 3: Build the package**

```bash
bun run --cwd=packages/typegen build
```

Expected: `packages/typegen/dist/` created with `index.js`, `cli.js`, `.d.ts` files, no errors.

**Step 4: Smoke test the CLI against a local or real MCP (optional)**

If you have a running Mesh instance and a valid API key + virtual MCP ID:

```bash
node packages/typegen/dist/cli.js --mcp <your-mcp-id> --key <your-key> --output /tmp/test-client.ts
cat /tmp/test-client.ts
```

Expected: a valid TypeScript file with `export interface Tools { ... }` and `export const client = createMeshClient<Tools>({ ... })`.

**Step 5: Run fmt**

```bash
bun run fmt
```

Expected: no changes, or only whitespace diffs that then pass.

**Step 6: Final commit**

```bash
git add packages/typegen/
git commit -m "feat(typegen): build verification and formatting"
```

---

## Summary of Files Created

| File | Purpose |
|------|---------|
| `packages/typegen/package.json` | Package manifest, deps, bin |
| `packages/typegen/tsconfig.json` | TS config extending root |
| `packages/typegen/tsup.config.ts` | Build config (ESM, split) |
| `packages/typegen/src/index.ts` | Public types + re-exports |
| `packages/typegen/src/runtime.ts` | `createMeshClient` Proxy factory |
| `packages/typegen/src/runtime.test.ts` | Runtime unit tests |
| `packages/typegen/src/codegen.ts` | Schema → TypeScript generator |
| `packages/typegen/src/codegen.test.ts` | Codegen unit tests |
| `packages/typegen/src/cli.ts` | CLI bin (arg parse + orchestrate) |
