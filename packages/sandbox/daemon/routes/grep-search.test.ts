import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGrepArgs,
  expandGlobForGrepInclude,
  formatGrepToolError,
  isGrepMatchLine,
  makeGrepHandler,
  normalizeGrepResults,
  relativizePath,
  ripgrepInstallHint,
} from "./grep-search";

function post(obj: unknown): Request {
  return new Request("http://x/_sandbox/grep", {
    method: "POST",
    body: JSON.stringify(obj),
    headers: { "Content-Type": "application/json" },
  });
}

describe("grep-search", () => {
  it("buildGrepArgs: maps rg content mode", () => {
    expect(
      buildGrepArgs(
        { pattern: "foo", output_mode: "content", ignore_case: true },
        "/repo",
        "rg",
      ),
    ).toEqual(["--line-number", "-i", "--color=never", "--", "foo", "/repo"]);
  });

  it("expandGlobForGrepInclude: expands brace globs", () => {
    expect(expandGlobForGrepInclude("**/*.{ts,tsx}")).toEqual([
      "*.ts",
      "*.tsx",
    ]);
    expect(expandGlobForGrepInclude("{ts,tsx}")).toEqual(["*.ts", "*.tsx"]);
    expect(expandGlobForGrepInclude("**/*.ts")).toEqual(["*.ts"]);
  });

  it("formatGrepToolError: maps invalid regex to 400", () => {
    const { message, status } = formatGrepToolError(
      "grep: brackets ([ ]) not balanced",
      2,
      "grep",
    );
    expect(status).toBe(400);
    expect(message).toBe("Invalid regex pattern: brackets ([ ]) not balanced");
  });

  it("buildGrepArgs: passes pattern via -e for grep", () => {
    const args = buildGrepArgs(
      { pattern: "^import React", glob: "{ts,tsx}" },
      "/repo",
      "grep",
    );
    expect(args).toContain("-e");
    expect(args).toContain("^import React");
    expect(args).toContain("*.ts");
    expect(args).toContain("*.tsx");
  });

  it("buildGrepArgs: maps grep brace globs to multiple --include flags", () => {
    const args = buildGrepArgs(
      { pattern: ": any", glob: "**/*.{ts,tsx}" },
      "/repo",
      "grep",
    );
    expect(args).toContain("-E");
    expect(args.filter((a) => a === "--include")).toHaveLength(2);
    expect(args).toContain("*.ts");
    expect(args).toContain("*.tsx");
  });

  it("relativizePath: strips absolute repo prefix", () => {
    expect(
      relativizePath(
        "/var/sandbox/repo/components/product/Gallery.tsx",
        "/var/sandbox/repo",
      ),
    ).toBe("components/product/Gallery.tsx");
  });

  it("normalizeGrepResults: relativizes absolute paths", () => {
    const repoDir = "/var/sandbox/repo";
    const { results, matchCount } = normalizeGrepResults(
      `${repoDir}/components/product/Gallery.tsx:42:const x: any = 1`,
      repoDir,
      { pattern: "any", output_mode: "content" },
    );
    expect(results).toBe("components/product/Gallery.tsx:42:const x: any = 1");
    expect(matchCount).toBe(1);
  });

  it("isGrepMatchLine: ignores context lines when counting matches", () => {
    expect(isGrepMatchLine("components/foo.ts:12:match", "content", true)).toBe(
      true,
    );
    expect(
      isGrepMatchLine("components/foo.ts-11-context", "content", true),
    ).toBe(false);
    expect(isGrepMatchLine("--", "content", true)).toBe(false);
  });

  it("normalizeGrepResults: matchCount excludes context lines", () => {
    const repoDir = "/repo";
    const stdout = [
      `${repoDir}/src/a.ts-1-before`,
      `${repoDir}/src/a.ts:2:match here`,
      `${repoDir}/src/a.ts-3-after`,
    ].join("\n");
    const { matchCount, lineCount } = normalizeGrepResults(stdout, repoDir, {
      pattern: "match",
      output_mode: "content",
      context: 1,
    });
    expect(lineCount).toBe(3);
    expect(matchCount).toBe(1);
  });

  it("ripgrepInstallHint: returns platform-specific guidance", () => {
    expect(typeof ripgrepInstallHint()).toBe("string");
    expect(ripgrepInstallHint().length).toBeGreaterThan(0);
  });

  it("makeGrepHandler: searches with brace globs and alternation patterns", async () => {
    const appRoot = mkdtempSync(join(tmpdir(), "grep-search-"));
    try {
      writeFileSync(join(appRoot, "sample.ts"), "const x: any = 1;\n");
      writeFileSync(join(appRoot, "sample.tsx"), "const y = foo as any;\n");
      const h = makeGrepHandler({ appRoot, repoDir: appRoot });
      const res = await h(
        post({
          pattern: ": any[^[]|as any",
          glob: "**/*.{ts,tsx}",
          output_mode: "content",
          limit: 100,
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: string;
        matchCount: number;
      };
      expect(body.matchCount).toBe(2);
      expect(body.results).toContain("sample.ts:");
      expect(body.results).not.toContain(appRoot);
      expect(body).not.toHaveProperty("warning");
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  it("makeGrepHandler: matches line-start patterns with bare brace globs", async () => {
    const appRoot = mkdtempSync(join(tmpdir(), "grep-search-anchor-"));
    try {
      writeFileSync(join(appRoot, "App.tsx"), 'import React from "react";\n');
      const h = makeGrepHandler({ appRoot, repoDir: appRoot });
      const res = await h(
        post({
          pattern: "^import React",
          glob: "{ts,tsx}",
          output_mode: "content",
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: string;
        matchCount: number;
      };
      expect(body.matchCount).toBe(1);
      expect(body.results).toContain("App.tsx:");
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  it("makeGrepHandler: returns friendly error for invalid regex", async () => {
    const appRoot = mkdtempSync(join(tmpdir(), "grep-search-invalid-"));
    try {
      writeFileSync(join(appRoot, "a.ts"), "hello\n");
      const h = makeGrepHandler({ appRoot, repoDir: appRoot });
      const res = await h(
        post({
          pattern: "[invalid regex ((((",
          output_mode: "content",
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toStartWith("Invalid regex pattern:");
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  it("makeGrepHandler: matchCount ignores context lines", async () => {
    const appRoot = mkdtempSync(join(tmpdir(), "grep-search-ctx-"));
    try {
      mkdirSync(join(appRoot, "src"), { recursive: true });
      writeFileSync(join(appRoot, "src", "a.ts"), "line0\nmatch line\nline2\n");
      const h = makeGrepHandler({ appRoot, repoDir: appRoot });
      const res = await h(
        post({
          pattern: "match line",
          glob: "**/*.ts",
          output_mode: "content",
          context: 1,
          limit: 100,
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: string;
        matchCount: number;
      };
      expect(body.matchCount).toBe(1);
      expect(body.results.split("\n").length).toBeGreaterThan(1);
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });
});
