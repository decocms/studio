import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverScripts } from "./script-discovery";

describe("discoverScripts", () => {
  it("reads scripts from package.json for npm/pnpm/yarn/bun", () => {
    const root = mkdtempSync(join(tmpdir(), "scripts-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }),
    );
    expect(discoverScripts(root, "npm")).toEqual(["dev", "build"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("reads tasks from deno.json for deno", () => {
    const root = mkdtempSync(join(tmpdir(), "scripts-"));
    writeFileSync(
      join(root, "deno.json"),
      JSON.stringify({ tasks: { serve: "deno run x" } }),
    );
    expect(discoverScripts(root, "deno")).toEqual(["serve"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty when no package.json", () => {
    const root = mkdtempSync(join(tmpdir(), "scripts-"));
    expect(discoverScripts(root, "npm")).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty when PM is null", () => {
    expect(discoverScripts("/nonexistent", null)).toEqual([]);
  });
});
