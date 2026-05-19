import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeDenoTasks } from "./sanitize-deno";

function makeTmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sanitize-deno-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("sanitizeDenoTasks", () => {
  it("strips --unstable-hmr from task values", () => {
    const { dir, cleanup } = makeTmp();
    try {
      fs.writeFileSync(
        join(dir, "deno.json"),
        JSON.stringify({
          tasks: {
            dev: "deno run --unstable-hmr main.ts",
            start: "deno run main.ts",
          },
        }),
      );
      const changed = sanitizeDenoTasks(dir);
      expect(changed).toBe(true);

      const result = JSON.parse(
        fs.readFileSync(join(dir, "deno.json"), "utf-8"),
      );
      expect(result.tasks.dev).toBe("deno run main.ts");
      expect(result.tasks.start).toBe("deno run main.ts");
    } finally {
      cleanup();
    }
  });

  it("strips --unstable-hmr with a value (--unstable-hmr=...)", () => {
    const { dir, cleanup } = makeTmp();
    try {
      fs.writeFileSync(
        join(dir, "deno.json"),
        JSON.stringify({
          tasks: { dev: "deno run --unstable-hmr=./src main.ts" },
        }),
      );
      const changed = sanitizeDenoTasks(dir);
      expect(changed).toBe(true);

      const result = JSON.parse(
        fs.readFileSync(join(dir, "deno.json"), "utf-8"),
      );
      expect(result.tasks.dev).toBe("deno run main.ts");
    } finally {
      cleanup();
    }
  });

  it("returns false when no banned flags are present", () => {
    const { dir, cleanup } = makeTmp();
    try {
      fs.writeFileSync(
        join(dir, "deno.json"),
        JSON.stringify({ tasks: { dev: "deno run main.ts" } }),
      );
      expect(sanitizeDenoTasks(dir)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("returns false when no deno.json exists", () => {
    const { dir, cleanup } = makeTmp();
    try {
      expect(sanitizeDenoTasks(dir)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("handles deno.jsonc as well", () => {
    const { dir, cleanup } = makeTmp();
    try {
      fs.writeFileSync(
        join(dir, "deno.jsonc"),
        JSON.stringify({ tasks: { dev: "deno run --unstable-hmr server.ts" } }),
      );
      const changed = sanitizeDenoTasks(dir);
      expect(changed).toBe(true);

      const result = JSON.parse(
        fs.readFileSync(join(dir, "deno.jsonc"), "utf-8"),
      );
      expect(result.tasks.dev).toBe("deno run server.ts");
    } finally {
      cleanup();
    }
  });
});
