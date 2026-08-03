import { describe, expect, it } from "bun:test";
import { Glob } from "bun";

// Keep the reusable harness sources from reaching into route, provider, or
// shared app internals through relative imports. Hosted adapters may depend on
// StudioContext and the explicit environment builder.
//
// Excludes:
//  - *.integration.test.ts (DB-backed; stays studio-side, not packaged)
//  - index.ts (top-level studio barrel)
const EXCLUDED = new Set(["index.ts"]);
const CROSS_TREE =
  /from\s+["'](?:\.\.\/)+(?:api\/routes\/decopilot|ai-providers|shared)\//;

describe("harness tree is cross-tree-free", () => {
  it("keeps reusable sources out of route and provider internals", async () => {
    const root = new URL("./", import.meta.url).pathname;
    const offenders: string[] = [];
    for await (const rel of new Glob("**/*.ts").scan(root)) {
      if (rel.endsWith(".integration.test.ts")) continue;
      const base = rel.split("/").pop()!;
      if (rel === base && EXCLUDED.has(base)) continue;
      const src = await Bun.file(root + rel).text();
      if (CROSS_TREE.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

// Keep the direct @decocms/sandbox dependency explicit and small.
// Only `agent-sandbox-fs.ts` may bridge into sandbox: it constructs the
// hosted AgentSandbox provider + fs hooks.
// Every other production file consumes the harness-owned flat `SandboxFsHooks`
// via DI and stays sandbox-free.
const SANDBOX_GLUE = new Set(["decopilot/built-in-tools/agent-sandbox-fs.ts"]);
const SANDBOX_IMPORT = /from\s+["']@decocms\/sandbox/;

describe("harness tree is @decocms/sandbox-free", () => {
  it("keeps @decocms/sandbox imports in the hosted glue", async () => {
    const root = new URL("./", import.meta.url).pathname;
    const offenders: string[] = [];
    for await (const rel of new Glob("**/*.ts").scan(root)) {
      if (rel.endsWith(".test.ts")) continue; // tests MAY import sandbox
      if (SANDBOX_GLUE.has(rel)) continue; // the isolated glue seam
      const src = await Bun.file(root + rel).text();
      if (SANDBOX_IMPORT.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
