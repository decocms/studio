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
  test("bans a value import from a server-only tree", async () => {
    const f = fixture(
      "apps/mesh/src/web/a.ts",
      `import { db } from "@/storage/types";\nexport const x = db;\n`,
    );
    expect((await lint(f)).length).toBe(1);
  });

  test("bans a value import from @/tools schema", async () => {
    const f = fixture(
      "apps/mesh/src/web/b.ts",
      `import { ConnectionSchema } from "@/tools/connection/schema";\nexport const x = ConnectionSchema;\n`,
    );
    expect((await lint(f)).length).toBe(1);
  });

  test("allows `import type` from a server tree (erased at build)", async () => {
    const f = fixture(
      "apps/mesh/src/web/c.ts",
      `import type { Thread } from "@/storage/types";\nexport type T = Thread;\n`,
    );
    expect((await lint(f)).length).toBe(0);
  });

  test("allows `import { type X }` inline type specifiers", async () => {
    const f = fixture(
      "apps/mesh/src/web/d.ts",
      `import { type ChatMessage } from "@/api/routes/decopilot/types";\nexport type M = ChatMessage;\n`,
    );
    expect((await lint(f)).length).toBe(0);
  });

  test("allows value imports from frontend-safe trees (mcp-apps, web, lib)", async () => {
    const f = fixture(
      "apps/mesh/src/web/e.ts",
      `import { MCPAppRenderer } from "@/mcp-apps/mcp-app-renderer.tsx";\n` +
        `import { thing } from "@/web/lib/thing";\n` +
        `import { util } from "@/lib/util";\n` +
        `export const x = [MCPAppRenderer, thing, util];\n`,
    );
    expect((await lint(f)).length).toBe(0);
  });

  test("bans a dynamic import from a server tree", async () => {
    const f = fixture(
      "apps/mesh/src/web/f.ts",
      `export const load = () => import("@/core/studio-context");\n`,
    );
    expect((await lint(f)).length).toBe(1);
  });

  test("bans a value re-export from a server tree", async () => {
    const f = fixture(
      "apps/mesh/src/web/g.ts",
      `export { MCP_MESH_KEY } from "@/core/constants";\n`,
    );
    expect((await lint(f)).length).toBe(1);
  });

  test("ignores files outside the web tree", async () => {
    const f = fixture(
      "apps/mesh/src/api/h.ts",
      `import { db } from "@/storage/types";\nexport const x = db;\n`,
    );
    expect((await lint(f)).length).toBe(0);
  });

  test("ignores in-tree relative and workspace-package imports", async () => {
    const f = fixture(
      "apps/mesh/src/web/i.ts",
      `import { a } from "./sibling";\nimport { useProjectContext } from "@decocms/mesh-sdk";\n` +
        `export const x = [a, useProjectContext];\n`,
    );
    expect((await lint(f)).length).toBe(0);
  });

  // Allowlist means any not-explicitly-safe tree is guarded by default. `cli`
  // is server-only but was not in the old blocklist — it must be caught now.
  test("bans a value import from an unlisted server tree (cli)", async () => {
    const f = fixture(
      "apps/mesh/src/web/j.ts",
      `import { run } from "@/cli/cli-store";\nexport const x = run;\n`,
    );
    expect((await lint(f)).length).toBe(1);
  });

  // Web test files never ship in the browser bundle → outside this rule.
  test("ignores web test files (not bundled)", async () => {
    const f = fixture(
      "apps/mesh/src/web/x.test.ts",
      `import { render } from "@/test/render";\nexport const x = render;\n`,
    );
    expect((await lint(f)).length).toBe(0);
  });

  // Relative climbs out of web/ into a server tree bypass the `@/` prefix.
  test("bans a relative climb out of web into a server tree", async () => {
    const f = fixture(
      "apps/mesh/src/web/components/k.ts",
      `import { db } from "../../storage/types";\nexport const x = db;\n`,
    );
    expect((await lint(f)).length).toBe(1);
  });
});
