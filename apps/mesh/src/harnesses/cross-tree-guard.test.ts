import { describe, expect, it } from "bun:test";
import { Glob } from "bun";

// Step-2 exit gate: the portable to-move set must not reach the cluster tree
// via relative imports. The guard targets the three cluster-only trees the
// extraction is severing — `api/routes/decopilot`, `ai-providers`, `shared`
// (see plan §H Task 9, "no production harness source reaches
// ../../api/routes/decopilot/*, ../../ai-providers/*, or ../../shared/*").
//
// `core`/`storage`/`tools` are intentionally NOT in the pattern: the
// cluster-side DI assemblers (`in-process-sandbox-client.ts`,
// `decopilot/harness-deps.ts`, `decopilot/index.ts`) legitimately keep
// `StudioContext`/`HarnessContext` type reaches (`../core/studio-context`,
// `../../core/harness-context`) — that DI surface is rewritten to
// `@decocms/harness` specifiers in the later package-move slice, not here.
//
// Excludes:
//  - *.integration.test.ts (DB-backed; stays mesh-side, not packaged)
//  - local-dispatch.ts / index.ts (mesh-only, folded into InProcessSandboxClient)
const EXCLUDED = new Set([
  "local-dispatch.ts",
  "local-dispatch.test.ts",
  "index.ts", // top-level mesh barrel
]);
const CROSS_TREE =
  /from\s+["'](?:\.\.\/)+(?:api\/routes\/decopilot|ai-providers|shared)\//;

describe("harness tree is cross-tree-free", () => {
  it("has no portable source reaching the cluster tree", async () => {
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
