import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TMP = `${ROOT}/.ban-cross-tree.tmp`;
const CONFIG = `${TMP}/.oxlintrc.json`;

// Plugin path is relative to CONFIG's directory (TMP), so we go one level up
// to reach the repo root where plugins/ lives.
const CONFIG_JSON = JSON.stringify({
  jsPlugins: ["../plugins/ban-cross-tree-imports.js"],
  rules: { "ban-cross-tree-imports/ban-cross-tree-imports": "error" },
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
    .filter((d) => d.code.includes("ban-cross-tree-imports"))
    .map((d) => d.message);
}

function fixture(relPath: string, contents: string): string {
  const abs = `${TMP}/${relPath}`;
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, contents);
  return `.ban-cross-tree.tmp/${relPath}`;
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(CONFIG, CONFIG_JSON);
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("ban-cross-tree-imports", () => {
  test("bans @/ import from a packages/ file", async () => {
    const f = fixture(
      "packages/sandbox/x.ts",
      `import { z } from "@/core/studio-context";\nexport const a = z;\n`,
    );
    const msgs = await lint(f);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain("@/");
  });

  test("bans relative apps/api reach-in from a packages/ file", async () => {
    const f = fixture(
      "packages/sandbox/y.ts",
      `import { p } from "../../../../apps/api/src/harnesses/offload-messages";\nexport const b = p;\n`,
    );
    const msgs = await lint(f);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain("apps/api");
  });

  test("bans @aws-sdk/* only inside packages/harness/", async () => {
    const f = fixture(
      "packages/harness/s3.ts",
      `import { S3 } from "@aws-sdk/client-s3";\nexport const c = S3;\n`,
    );
    const msgs = await lint(f);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain("@aws-sdk");
  });

  test("allows @aws-sdk/* in a non-harness package", async () => {
    const f = fixture(
      "packages/sandbox/s3.ts",
      `import { S3 } from "@aws-sdk/client-s3";\nexport const d = S3;\n`,
    );
    expect(await lint(f)).toEqual([]);
  });

  test("ignores apps/api source files entirely", async () => {
    const f = fixture(
      "apps/api/src/z.ts",
      `import { q } from "@/core/studio-context";\nexport const e = q;\n`,
    );
    expect(await lint(f)).toEqual([]);
  });

  test("uses the dedicated harness message for @/core/studio-context inside packages/harness/", async () => {
    const f = fixture(
      "packages/harness/studio-context.ts",
      `import { S } from "@/core/studio-context";\nexport const h = S;\n`,
    );
    const msgs = await lint(f);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain("HarnessDeps");
  });

  test("catches export-from and dynamic import specifiers", async () => {
    const f = fixture(
      "packages/sandbox/reexport.ts",
      `export { r } from "@/core/server-constants";\n` +
        `export const load = () => import("../../../apps/web/src/x");\n` +
        `export * from "@/core/utils";\n`,
    );
    const msgs = await lint(f);
    expect(msgs.length).toBe(3);
  });
});

test("plugin is registered in .oxlintrc.json", () => {
  const cfg = JSON.parse(readFileSync(`${ROOT}/.oxlintrc.json`, "utf8")) as {
    jsPlugins: string[];
    rules: Record<string, string>;
  };
  expect(cfg.jsPlugins).toContain("./plugins/ban-cross-tree-imports.js");
  expect(cfg.rules["ban-cross-tree-imports/ban-cross-tree-imports"]).toBe(
    "warn",
  );
});
