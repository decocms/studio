/**
 * The hosted CMS files are clean today, so every case is a fixture: a rule
 * that matches nothing would look the same as a broken one.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

// Each test spawns a real `oxlint` subprocess.
setDefaultTimeout(20_000);

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TMP = `${ROOT}/.ban-cms-git.tmp`;
const CONFIG = `${TMP}/.oxlintrc.json`;

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
    .filter((d) => d.code.includes("ban-cms-git-imports"))
    .map((d) => d.message);
}

function fixture(relPath: string, contents: string): string {
  const abs = `${TMP}/${relPath}`;
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, contents);
  return `.ban-cms-git.tmp/${relPath}`;
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(
    CONFIG,
    JSON.stringify({
      jsPlugins: ["../plugins/ban-cms-git-imports.js"],
      rules: { "ban-cms-git-imports/ban-cms-git-imports": "error" },
    }),
  );
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("ban-cms-git-imports", () => {
  test("bans git-providers from the cms route", async () => {
    const f = fixture(
      "apps/api/src/api/routes/cms.ts",
      `import { contentClientForProjectRepo } from "@/git-providers";\nexport const x = contentClientForProjectRepo;\n`,
    );
    expect(await lint(f)).toHaveLength(1);
  });

  test("bans the repo readers and the v8 git path from hosted/cms-*", async () => {
    const f = fixture(
      "apps/api/src/hosted/cms-publish.ts",
      `import { gitBlobSha } from "@/decofile/read-decofile";\n` +
        `import { publishDraft } from "./publish";\n` +
        `export const x = [gitBlobSha, publishDraft];\n`,
    );
    expect(await lint(f)).toHaveLength(2);
  });

  test("bans the git decofile client from the web cms client", async () => {
    const f = fixture(
      "apps/web/src/components/sections-editor/cms-api.ts",
      `import { fetchDecofile } from "./decofile-api";\nexport const x = fetchDecofile;\n`,
    );
    expect(await lint(f)).toHaveLength(1);
  });

  test("allows R2 modules, and leaves files it doesn't cover alone", async () => {
    const ok = fixture(
      "apps/api/src/hosted/cms-storage.ts",
      `import { deliveryStore } from "./delivery-store";\nexport const x = deliveryStore;\n`,
    );
    expect(await lint(ok)).toEqual([]);
    const other = fixture(
      "apps/api/src/hosted/publish.ts",
      `import { requireBranchHead } from "@/git-providers";\nexport const x = requireBranchHead;\n`,
    );
    expect(await lint(other)).toEqual([]);
  });
});
