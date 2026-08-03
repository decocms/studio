import { describe, expect, it } from "bun:test";
import { Glob } from "bun";

// Leaf-discipline gate: the harness lib (the former @decocms/harness) and
// MUST stay free of the studio app tree. Any `@/` alias or relative reach into
// an `apps/*` tree would re-couple the package to the cluster and (since the package
// tsconfig has no `@/` paths) break `tsc` — this guard catches it explicitly,
// including transitive relative escapes that a path-alias check would miss.
//
// `@decocms/*` workspace deps are allowed (declared in package.json). The
// package is also `@decocms/sandbox`-free by design — the sandbox glue lives in
// studio (cluster-sandbox-fs.ts) / the daemon, never here.
const BANNED =
  /from\s+["'](?:@\/|(?:\.\.\/)+(?:apps\/[^/]+|app\/)|@decocms\/sandbox)/;

describe("harness lib is cross-tree-free", () => {
  it("has no `@/`, apps/*, or @decocms/sandbox imports", async () => {
    const root = new URL("./", import.meta.url).pathname;
    const offenders: string[] = [];
    for await (const rel of new Glob("**/*.ts").scan(root)) {
      const src = await Bun.file(root + rel).text();
      if (BANNED.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
