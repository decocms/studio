/**
 * A boundary rule that matches nothing is indistinguishable from a broken one,
 * and this layer is clean today — so every case below is a fixture, not a
 * reading of the real tree.
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

// Each test spawns a real `oxlint` subprocess; see ban-web-server-imports.test.ts.
setDefaultTimeout(20_000);

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TMP = `${ROOT}/.ban-git-provider.tmp`;
const CONFIG = `${TMP}/.oxlintrc.json`;

const CONFIG_JSON = JSON.stringify({
  jsPlugins: ["../plugins/ban-git-provider-reachthrough.js"],
  rules: {
    "ban-git-provider-reachthrough/ban-git-provider-reachthrough": "error",
  },
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
    .filter((d) => d.code.includes("ban-git-provider-reachthrough"))
    .map((d) => d.message);
}

function fixture(relPath: string, contents: string): string {
  const abs = `${TMP}/${relPath}`;
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, contents);
  return `.ban-git-provider.tmp/${relPath}`;
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(CONFIG, CONFIG_JSON);
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("reaching into a provider from outside the layer", () => {
  test("bans the `@/` alias, which is how every real caller would write it", async () => {
    const f = fixture(
      "apps/api/src/tools/task-board/a.ts",
      `import { GithubContentClient } from "@/git-providers/github/content";\nexport const x = GithubContentClient;\n`,
    );
    const messages = await lint(f);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("git-providers/github");
    expect(messages[0]).toContain("@/git-providers");
  });

  test("bans a relative path that climbs into one", async () => {
    const f = fixture(
      "apps/api/src/decofile/b.ts",
      `import { GitlabContentClient } from "../git-providers/gitlab/content";\nexport const x = GitlabContentClient;\n`,
    );
    expect(await lint(f)).toHaveLength(1);
  });

  /** Type-only still couples the caller to a provider's object model. */
  test("bans a type-only import and a re-export", async () => {
    const typeOnly = fixture(
      "apps/api/src/tools/c.ts",
      `import type { RawPullRequest } from "@/git-providers/github/change-requests";\nexport type X = RawPullRequest;\n`,
    );
    expect(await lint(typeOnly)).toHaveLength(1);
    const reexport = fixture(
      "apps/api/src/tools/d.ts",
      `export { GithubProviderClient } from "@/git-providers/github/client";\n`,
    );
    expect(await lint(reexport)).toHaveLength(1);
  });

  test("allows the front door", async () => {
    const f = fixture(
      "apps/api/src/tools/task-board/e.ts",
      `import { changeRequestClientForOrigin } from "@/git-providers";\nexport const x = changeRequestClientForOrigin;\n`,
    );
    expect(await lint(f)).toEqual([]);
  });

  /**
   * The route file is NAMED for the layer without being in it. A rule keyed on
   * the name rather than the directory would flag every import it makes.
   */
  test("does not confuse a file named git-providers.ts with the directory", async () => {
    const f = fixture(
      "apps/api/src/api/routes/git-providers.ts",
      `import { readGithubAppConfig } from "@/git-providers/github/env";\nexport const x = readGithubAppConfig;\n`,
    );
    expect(await lint(f)).toEqual([]);
  });

  test("allows the second exception, App installations", async () => {
    const f = fixture(
      "apps/api/src/tools/github/list-user-orgs.ts",
      `import { githubFetch } from "@/git-providers/github/http";\nexport const x = githubFetch;\n`,
    );
    expect(await lint(f)).toEqual([]);
  });
});

describe("inside the layer", () => {
  test("lets the composition root reach both — that is its job", async () => {
    const f = fixture(
      "apps/api/src/git-providers/clients.ts",
      `import { GithubContentClient } from "./github/content";\n` +
        `import { GitlabContentClient } from "./gitlab/content";\n` +
        `export const x = [GithubContentClient, GitlabContentClient];\n`,
    );
    expect(await lint(f)).toEqual([]);
  });

  test("lets a provider import its own siblings and the shared contract", async () => {
    const f = fixture(
      "apps/api/src/git-providers/github/content.ts",
      `import { githubFetch } from "./http";\n` +
        `import type { RepoContentClient } from "../content";\n` +
        `export const x: RepoContentClient | typeof githubFetch = githubFetch;\n`,
    );
    expect(await lint(f)).toEqual([]);
  });

  /**
   * The case that motivated the second half of the rule: GitLab's change
   * requests once imported `summarizeChecks` from the GitHub side, which
   * quietly made its CI summary GitHub's.
   */
  test("bans one provider importing another", async () => {
    const f = fixture(
      "apps/api/src/git-providers/gitlab/change-requests.ts",
      `import { summarizeChecks } from "../github/change-requests";\nexport const x = summarizeChecks;\n`,
    );
    const messages = await lint(f);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("gitlab must not import github");
    expect(messages[0]).toContain("contract");
  });
});
