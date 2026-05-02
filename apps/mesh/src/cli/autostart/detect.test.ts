import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProject } from "./detect";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "autostart-detect-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePkg(
  root: string,
  scripts: Record<string, string>,
  deps: Record<string, string> = {},
) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "x", scripts, dependencies: deps }),
  );
}

describe("detectProject", () => {
  it("returns null for empty directory", () => {
    expect(detectProject(dir)).toBeNull();
  });

  it("returns null when cwd is a plain node project (no MCP shape)", () => {
    writePkg(dir, { dev: "vite" });
    expect(detectProject(dir)).toBeNull();
  });

  it("detects mcp/ subfolder with package.json + bun lock + dev script", () => {
    const mcp = join(dir, "mcp");
    writePkg(mcp, { dev: "bun run --hot api/main.bun.ts" });
    writeFileSync(join(mcp, "bun.lock"), "");
    const detected = detectProject(dir);
    expect(detected).not.toBeNull();
    expect(detected?.root).toBe(mcp);
    expect(detected?.packageManager).toBe("bun");
    expect(detected?.starter).toBe("dev");
  });

  it("falls back to start when dev script absent", () => {
    const mcp = join(dir, "mcp");
    writePkg(mcp, { start: "node server.js" });
    writeFileSync(join(mcp, "package-lock.json"), "{}");
    const detected = detectProject(dir);
    expect(detected?.packageManager).toBe("npm");
    expect(detected?.starter).toBe("start");
  });

  it("returns null when mcp/ exists but has no scripts", () => {
    const mcp = join(dir, "mcp");
    writePkg(mcp, {});
    writeFileSync(join(mcp, "bun.lock"), "");
    expect(detectProject(dir)).toBeNull();
  });

  it("detects pnpm via lockfile", () => {
    const mcp = join(dir, "mcp");
    writePkg(mcp, { dev: "next" });
    writeFileSync(join(mcp, "pnpm-lock.yaml"), "");
    expect(detectProject(dir)?.packageManager).toBe("pnpm");
  });

  it("detects yarn via lockfile", () => {
    const mcp = join(dir, "mcp");
    writePkg(mcp, { dev: "next" });
    writeFileSync(join(mcp, "yarn.lock"), "");
    expect(detectProject(dir)?.packageManager).toBe("yarn");
  });

  it("detects deno via deno.json + tasks", () => {
    const mcp = join(dir, "mcp");
    mkdirSync(mcp);
    writeFileSync(
      join(mcp, "deno.json"),
      JSON.stringify({ tasks: { dev: "deno run main.ts" } }),
    );
    const detected = detectProject(dir);
    expect(detected?.packageManager).toBe("deno");
    expect(detected?.starter).toBe("dev");
  });

  it("detects cwd-itself when api/main.*.ts exists", () => {
    writePkg(dir, { dev: "bun run api/main.bun.ts" });
    writeFileSync(join(dir, "bun.lock"), "");
    mkdirSync(join(dir, "api"));
    writeFileSync(join(dir, "api", "main.bun.ts"), "// stub");
    const detected = detectProject(dir);
    expect(detected?.root).toBe(dir);
  });

  it("detects cwd-itself when @decocms/runtime is a dep", () => {
    writePkg(dir, { dev: "bun run x" }, { "@decocms/runtime": "1.0.0" });
    writeFileSync(join(dir, "bun.lock"), "");
    const detected = detectProject(dir);
    expect(detected?.root).toBe(dir);
  });

  it("prefers mcp/ over cwd shape when both qualify", () => {
    // cwd has shape, but mcp/ also has a project — mcp/ wins
    writePkg(dir, { dev: "bun run x" }, { "@decocms/runtime": "1.0.0" });
    writeFileSync(join(dir, "bun.lock"), "");
    const mcp = join(dir, "mcp");
    writePkg(mcp, { dev: "bun run mcp" });
    writeFileSync(join(mcp, "bun.lock"), "");
    expect(detectProject(dir)?.root).toBe(mcp);
  });

  it("loads README preview when present", () => {
    const mcp = join(dir, "mcp");
    writePkg(mcp, { dev: "bun run x" });
    writeFileSync(join(mcp, "bun.lock"), "");
    writeFileSync(join(mcp, "README.md"), "# Hello\n\nWorld");
    expect(detectProject(dir)?.readmePreview).toContain("# Hello");
  });

  it("uses README H1 as the agent name when present", () => {
    const mcp = join(dir, "mcp");
    writePkg(mcp, { dev: "bun run x" });
    writeFileSync(join(mcp, "bun.lock"), "");
    writeFileSync(
      join(mcp, "README.md"),
      "# CEO Agent — Deco\n\nThe brain of the company.",
    );
    const detected = detectProject(dir);
    expect(detected?.name).toBe("CEO Agent — Deco");
    expect(detected?.description).toBe("The brain of the company.");
  });

  it("falls back to package.json#name (scope stripped) when no README H1", () => {
    const mcp = join(dir, "mcp");
    mkdirSync(mcp, { recursive: true });
    writeFileSync(
      join(mcp, "package.json"),
      JSON.stringify({ name: "@acme/cool-mcp", scripts: { dev: "x" } }),
    );
    writeFileSync(join(mcp, "bun.lock"), "");
    expect(detectProject(dir)?.name).toBe("cool-mcp");
  });

  it("falls back to dir basename when no README H1 nor pkg name", () => {
    const mcp = join(dir, "mcp");
    mkdirSync(mcp, { recursive: true });
    writeFileSync(
      join(mcp, "package.json"),
      JSON.stringify({ scripts: { dev: "x" } }),
    );
    writeFileSync(join(mcp, "bun.lock"), "");
    expect(detectProject(dir)?.name).toBe("mcp");
  });

  it("prefers package.json description over README paragraph", () => {
    const mcp = join(dir, "mcp");
    mkdirSync(mcp, { recursive: true });
    writeFileSync(
      join(mcp, "package.json"),
      JSON.stringify({
        description: "from pkg",
        scripts: { dev: "x" },
      }),
    );
    writeFileSync(join(mcp, "bun.lock"), "");
    writeFileSync(join(mcp, "README.md"), "# Hi\n\nfrom readme");
    expect(detectProject(dir)?.description).toBe("from pkg");
  });

  it("surfaces prompt.md as the promptFile", () => {
    const mcp = join(dir, "mcp");
    writePkg(mcp, { dev: "bun run x" });
    writeFileSync(join(mcp, "bun.lock"), "");
    writeFileSync(join(mcp, "prompt.md"), "You are the agent.");
    expect(detectProject(dir)?.promptFile).toBe(join(mcp, "prompt.md"));
  });

  it("falls back to AGENTS.md / CLAUDE.md when no prompt.md", () => {
    const mcp = join(dir, "mcp");
    writePkg(mcp, { dev: "bun run x" });
    writeFileSync(join(mcp, "bun.lock"), "");
    writeFileSync(join(mcp, "AGENTS.md"), "agent rules");
    expect(detectProject(dir)?.promptFile).toBe(join(mcp, "AGENTS.md"));
  });
});
