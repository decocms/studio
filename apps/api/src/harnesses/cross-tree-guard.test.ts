import { describe, expect, it } from "bun:test";
import { Glob } from "bun";

// Step-2 exit gate: the portable to-move set must not reach the cluster tree
// via relative imports. The guard targets the three cluster-only trees the
// extraction is severing — `api/routes/decopilot`, `ai-providers`, `shared`
// (see plan §H Task 9, "no production harness source reaches
// ../../api/routes/decopilot/*, ../../ai-providers/*, or ../../shared/*").
//
// `core`/`storage`/`tools` are intentionally NOT in the pattern: the
// cluster-side DI assemblers (`decopilot/harness-deps.ts`,
// `decopilot/index.ts`) legitimately keep
// `StudioContext`/`HarnessContext` type reaches (`../core/studio-context`,
// `../../core/harness-context`) — that DI surface is rewritten to
// harness-lib specifiers when the package moved, and stays that way.
//
// Excludes:
//  - *.integration.test.ts (DB-backed; stays studio-side, not packaged)
//  - index.ts (top-level studio barrel)
const EXCLUDED = new Set(["index.ts"]);
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

// Option-b sandbox decoupling: the portable harness was extracted to
// `@/harnesses/lib` (guarded there by apps/api/src/harnesses/lib/no-cross-tree.test.ts).
// What remains in this directory is the cluster island, which sits ABOVE
// `@decocms/sandbox` in the package DAG, so a `@decocms/sandbox` import here is
// not a layering violation — but we still keep that surface explicit and small.
// Only `cluster-sandbox-fs.ts` may bridge into sandbox: it constructs the
// cluster `SandboxProvider` + fs hooks.
// Every other production file consumes the harness-owned flat `SandboxFsHooks`
// via DI and stays sandbox-free. (`desktop-sandbox-fs.ts` relocated into
// `@decocms/sandbox/dispatch` with the desktop subtree in the package-move slice.)
const SANDBOX_GLUE = new Set([
  "decopilot/built-in-tools/cluster-sandbox-fs.ts",
]);
const SANDBOX_IMPORT = /from\s+["']@decocms\/sandbox/;

describe("harness tree is @decocms/sandbox-free", () => {
  it("has no portable source importing @decocms/sandbox (only the glue + tests)", async () => {
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
