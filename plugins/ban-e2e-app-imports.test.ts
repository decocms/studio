import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TMP = `${ROOT}/.ban-e2e-app-imports.tmp`;
const CONFIG = `${TMP}/.oxlintrc.json`;

// Plugin path is relative to CONFIG's directory (TMP), so we go one level up
// to reach the repo root where plugins/ lives.
const CONFIG_JSON = JSON.stringify({
  jsPlugins: ["../plugins/ban-e2e-app-imports.js"],
  rules: { "ban-e2e-app-imports/ban-e2e-app-imports": "error" },
});

async function lint(relPath: string): Promise<string[]> {
  const proc = Bun.spawn(
    ["node_modules/.bin/oxlint", "-c", CONFIG, "-f", "json", relPath],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const parsed = JSON.parse(out) as {
    diagnostics: { code: string; message: string }[];
  };
  return parsed.diagnostics
    .filter((d) => d.code.includes("ban-e2e-app-imports"))
    .map((d) => d.message);
}

function fixture(relPath: string, contents: string): string {
  const abs = `${TMP}/${relPath}`;
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, contents);
  return `.ban-e2e-app-imports.tmp/${relPath}`;
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(CONFIG, CONFIG_JSON);
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("ban-e2e-app-imports", () => {
  test("allows relative imports from a packages/e2e file", async () => {
    const f = fixture(
      "packages/e2e/fixtures/a.ts",
      `import { x } from "./b";\nexport const a = x;\n`,
    );
    expect(await lint(f)).toEqual([]);
  });

  test("allows allowlisted packages and node: builtins", async () => {
    const f = fixture(
      "packages/e2e/fixtures/allow.ts",
      `import { test } from "@playwright/test";\n` +
        `import { Client } from "pg";\n` +
        `import { z } from "zod";\n` +
        `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\n` +
        `import { sleep } from "@decocms/shared/std";\n` +
        `import { readFileSync } from "node:fs";\n` +
        `export const all = [test, Client, z, McpServer, sleep, readFileSync];\n`,
    );
    expect(await lint(f)).toEqual([]);
  });

  test("bans packages dropped from the allowlist with the link removal", async () => {
    const f = fixture(
      "packages/e2e/fixtures/dropped.ts",
      `import { jetstream } from "@nats-io/jetstream";\n` +
        `import { encodeSubjectToken } from "@decocms/tunnel/subject";\n` +
        `import type { Capability } from "@decocms/sandbox/dispatch";\n` +
        `import { DEFAULT_THREAD_TITLE } from "@decocms/harness/decopilot/prompt-constants";\n` +
        `export const all = [jetstream, encodeSubjectToken, DEFAULT_THREAD_TITLE];\n` +
        `export type C = Capability;\n`,
    );
    const msgs = await lint(f);
    expect(msgs.length).toBe(4);
    expect(msgs.every((m) => m.includes("allowlist"))).toBe(true);
  });

  test("bans apps/*/src reach-ins", async () => {
    const f = fixture(
      "packages/e2e/fixtures/reach.ts",
      `import { isOrgArchived } from "../../../apps/api/src/core/org-archived";\nexport const r = isOrgArchived;\n`,
    );
    const msgs = await lint(f);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain("app source");
  });

  test("bans an @/ app path alias", async () => {
    const f = fixture(
      "packages/e2e/fixtures/alias.ts",
      `import { workItemSchema } from "@/links/link-work-item";\nexport const w = workItemSchema;\n`,
    );
    const msgs = await lint(f);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain("@/");
  });

  test("bans a non-allowlisted npm package", async () => {
    const f = fixture(
      "packages/e2e/fixtures/react.ts",
      `import { useState } from "react";\nexport const u = useState;\n`,
    );
    const msgs = await lint(f);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain("allowlist");
  });

  test("bans a non-allowlisted @decocms/* package (app code in packages)", async () => {
    const f = fixture(
      "packages/e2e/fixtures/runtime.ts",
      `import { thing } from "@decocms/runtime";\nexport const t = thing;\n`,
    );
    const msgs = await lint(f);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain("allowlist");
  });

  test("catches export-from and dynamic import specifiers", async () => {
    const f = fixture(
      "packages/e2e/fixtures/reexport.ts",
      `export { r } from "@/core/server-constants";\n` +
        `export const load = () => import("../../../apps/web/src/x");\n` +
        `export * from "react";\n`,
    );
    const msgs = await lint(f);
    expect(msgs.length).toBe(3);
  });

  test("ignores files outside packages/e2e entirely", async () => {
    const f = fixture(
      "apps/api/src/z.ts",
      `import { q } from "@/core/studio-context";\nexport const e = q;\n`,
    );
    expect(await lint(f)).toEqual([]);
  });
});

test("plugin is registered in .oxlintrc.json at error level", () => {
  const cfg = JSON.parse(readFileSync(`${ROOT}/.oxlintrc.json`, "utf8")) as {
    jsPlugins: string[];
    rules: Record<string, string>;
  };
  expect(cfg.jsPlugins).toContain("./plugins/ban-e2e-app-imports.js");
  expect(cfg.rules["ban-e2e-app-imports/ban-e2e-app-imports"]).toBe("error");
});
