import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TMP = `${ROOT}/.ban-web-server.tmp`;
const CONFIG = `${TMP}/.oxlintrc.json`;

const CONFIG_JSON = JSON.stringify({
  jsPlugins: ["../plugins/ban-web-server-imports.js"],
  rules: { "ban-web-server-imports/ban-web-server-imports": "error" },
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
    .filter((d) => d.code.includes("ban-web-server-imports"))
    .map((d) => d.message);
}

function fixture(relPath: string, contents: string): string {
  const abs = `${TMP}/${relPath}`;
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, contents);
  return `.ban-web-server.tmp/${relPath}`;
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(CONFIG, CONFIG_JSON);
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("ban-web-server-imports", () => {
  test("bans a value import from apps/api source", async () => {
    const f = fixture(
      "apps/web/src/a.ts",
      `import { db } from "../../api/src/storage/types";\nexport const x = db;\n`,
    );
    expect((await lint(f)).length).toBe(1);
  });

  test("bans a type-only import from apps/api source", async () => {
    const f = fixture(
      "apps/web/src/b.ts",
      `import type { Thread } from "../../api/src/storage/types";\nexport type T = Thread;\n`,
    );
    const msgs = await lint(f);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain("@decocms/shared/*");
  });

  test("allows app-local aliases and relative imports", async () => {
    const f = fixture(
      "apps/web/src/c.ts",
      `import { component } from "@/components/component";\n` +
        `import { helper } from "./helper";\n` +
        `export const x = [component, helper];\n`,
    );
    expect(await lint(f)).toEqual([]);
  });

  test("allows workspace-package imports", async () => {
    const f = fixture(
      "apps/web/src/d.ts",
      `import { WellKnownOrgMCPId } from "@decocms/shared/sdk/constants";\n` +
        `import type { Metadata } from "@decocms/shared/chat";\n` +
        `export const x = WellKnownOrgMCPId;\nexport type M = Metadata;\n`,
    );
    expect(await lint(f)).toEqual([]);
  });

  test("bans a dynamic import from apps/api source", async () => {
    const f = fixture(
      "apps/web/src/e.ts",
      `export const load = () => import("../../api/src/core/studio-context");\n`,
    );
    expect((await lint(f)).length).toBe(1);
  });

  test("bans a value re-export from apps/api source", async () => {
    const f = fixture(
      "apps/web/src/f.ts",
      `export { SERVER_ONLY_VALUE } from "../../api/src/core/constants";\n`,
    );
    expect((await lint(f)).length).toBe(1);
  });

  test("ignores files outside the web app", async () => {
    const f = fixture(
      "apps/api/src/g.ts",
      `import { db } from "./storage/types";\nexport const x = db;\n`,
    );
    expect(await lint(f)).toEqual([]);
  });

  test("enforces the boundary in web test files too", async () => {
    const f = fixture(
      "apps/web/src/h.test.ts",
      `import { render } from "../../api/src/test/render";\nexport const x = render;\n`,
    );
    expect((await lint(f)).length).toBe(1);
  });

  test("resolves a nested relative climb into apps/api", async () => {
    const f = fixture(
      "apps/web/src/components/i.ts",
      `import { db } from "../../../api/src/storage/types";\nexport const x = db;\n`,
    );
    expect((await lint(f)).length).toBe(1);
  });
});
