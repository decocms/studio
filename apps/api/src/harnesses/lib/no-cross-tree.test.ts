import { describe, expect, it } from "bun:test";
import { Glob } from "bun";

// Keep the reusable Decopilot core free of app-tree and sandbox imports. The
// StudioContext-backed hosted adapter lives in `harnesses/decopilot/index.ts`.
const BANNED =
  /from\s+["'](?:@\/|(?:\.\.\/)+(?:apps\/[^/]+|app\/)|@decocms\/sandbox)/;

describe("harness lib is cross-tree-free", () => {
  it("has no app-tree or sandbox imports", async () => {
    const root = new URL("./", import.meta.url).pathname;
    const offenders: string[] = [];
    for await (const rel of new Glob("**/*.ts").scan(root)) {
      const src = await Bun.file(root + rel).text();
      if (BANNED.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
