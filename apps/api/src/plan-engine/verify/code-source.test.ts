import { describe, expect, test } from "bun:test";
import {
  GitProviderError,
  type ReadFileParams,
  type RepoInsightsClient,
} from "@/git-providers";
import {
  CODE_UNAVAILABLE,
  type CodeAccess,
  CodeGapError,
  codeGapOf,
  lazyCodeReader,
  noRepositoryGap,
  notLinkedGap,
  openRepoView,
  repoLabel,
  skippedFilesGap,
  unusableGap,
} from "./code-source.ts";

/** A repository already resolved: its tree and its files, at ref `main`. */
interface RepoFixture {
  entries: Array<{ path: string; type?: "blob" | "tree"; size?: number }>;
  truncated?: boolean;
  files: Record<string, string>;
  /** Files the provider returns cut at the byte budget. */
  big?: string[];
}

function repoFiles(repo: RepoFixture) {
  const reads: ReadFileParams[] = [];
  let trees = 0;
  const files: Pick<RepoInsightsClient, "listTree" | "readFile"> = {
    listTree: async () => {
      trees++;
      return {
        ref: "main",
        entries: repo.entries.map((e) => ({ type: "blob" as const, ...e })),
        truncated: repo.truncated ?? false,
      };
    },
    readFile: async (params) => {
      reads.push(params);
      const text = repo.files[params.path];
      return {
        content: text ?? null,
        size: text?.length ?? null,
        truncated: repo.big?.includes(params.path) ?? false,
      };
    },
  };
  return { files, reads, trees: () => trees };
}

const tanstack: RepoFixture = {
  entries: [
    { path: "package.json" },
    { path: ".deco/blocks/pages-productpage-1.json" },
    { path: "src", type: "tree" },
    { path: "src/sections/Product/PDP.tsx", size: 10 },
    { path: "src/components/Gallery.tsx" },
    { path: "src/styles/app.css" },
  ],
  files: {
    ".deco/blocks/pages-productpage-1.json": "{}",
    "src/sections/Product/PDP.tsx": "pdp",
    "src/components/Gallery.tsx": "gallery",
    "src/styles/app.css": ":root{}",
  },
};

const REPO = "acme/loja-exemplo";

describe("openRepoView", () => {
  test("mirror paths: X first, then src/X; the tree is read once", async () => {
    const r = repoFiles(tanstack);
    const view = openRepoView(r.files, REPO);
    expect(view.repo).toBe(REPO);
    expect(await view.read("sections/Product/PDP.tsx")).toBe("pdp");
    expect(await view.read("components/Gallery.tsx")).toBe("gallery");
    expect(await view.read(".deco/blocks/pages-productpage-1.json")).toBe("{}");
    expect(await view.read("src/components/Gallery.tsx")).toBe("gallery");
    expect(r.trees()).toBe(1);
    // Pinned to the ref the tree read, at the read ceiling.
    expect(r.reads.every((c) => c.ref === "main")).toBe(true);
    expect(r.reads.every((c) => c.maxBytes === 200_000)).toBe(true);
  });

  test("a path the whole tree does not have is null, without a file read", async () => {
    const r = repoFiles(tanstack);
    const view = openRepoView(r.files, REPO);
    expect(await view.read("components/Nope.tsx")).toBeNull();
    expect(r.reads).toHaveLength(0);
  });

  test("a truncated tree falls back to asking for X, then src/X", async () => {
    const r = repoFiles({ ...tanstack, entries: [], truncated: true });
    const view = openRepoView(r.files, REPO);
    expect(await view.read("components/Gallery.tsx")).toBe("gallery");
    expect(r.reads.map((c) => c.path)).toEqual([
      "components/Gallery.tsx",
      "src/components/Gallery.tsx",
    ]);
  });

  test("a file over the read ceiling is skipped and recorded, not read cut", async () => {
    const r = repoFiles({ ...tanstack, big: ["src/components/Gallery.tsx"] });
    const view = openRepoView(r.files, REPO);
    expect(await view.read("components/Gallery.tsx")).toBeNull();
    expect(await view.read("sections/Product/PDP.tsx")).toBe("pdp");
    expect(view.skipped()).toEqual(["src/components/Gallery.tsx"]);
    const gap = skippedFilesGap(view.skipped());
    expect(gap?.error).toContain("src/components/Gallery.tsx");
    expect(gap?.error).toContain("200 KB");
    expect(skippedFilesGap(["a", "b"])?.error).toContain("2 arquivos ficaram");
    expect(skippedFilesGap([])).toBeNull();
  });

  test("listing in mirror paths merges the root and src/; raw keeps the repo's", async () => {
    const r = repoFiles(tanstack);
    const view = openRepoView(r.files, REPO);
    const names = (await view.list("")).map((e) => `${e.type}:${e.path}`);
    expect(names).toContain("file:package.json");
    expect(names).toContain("dir:.deco");
    expect(names).toContain("dir:sections");
    expect(names).toContain("dir:styles");
    expect((await view.list("components")).map((e) => e.path)).toEqual([
      "components/Gallery.tsx",
    ]);
    expect(await view.list(".deco/blocks")).toEqual([
      {
        name: "pages-productpage-1.json",
        path: ".deco/blocks/pages-productpage-1.json",
        type: "file",
        size: 0,
      },
    ]);
    expect((await view.raw.list("src/styles")).map((e) => e.path)).toEqual([
      "src/styles/app.css",
    ]);
    expect(await view.raw.read("styles/app.css")).toBeNull();
    expect(await view.raw.read("src/styles/app.css")).toBe(":root{}");
    expect(r.trees()).toBe(1);
  });

  test("an empty or missing folder lists empty", async () => {
    const view = openRepoView(
      repoFiles({ entries: [], files: {} }).files,
      REPO,
    );
    expect(await view.list("")).toEqual([]);
    expect(await view.list("nope/")).toEqual([]);
  });

  test("a provider failure reading the tree surfaces on the first read", async () => {
    const view = openRepoView(
      {
        listTree: async () => {
          throw new GitProviderError({
            provider: "github",
            status: 500,
            message: "boom",
          });
        },
        readFile: async () => ({ content: null, size: null, truncated: false }),
      },
      REPO,
    );
    await expect(view.read("a.ts")).rejects.toThrow("boom");
  });
});

describe("lazyCodeReader", () => {
  test("opens once, on the first file asked for; absent without access", async () => {
    const r = repoFiles({
      entries: [{ path: "a.ts" }, { path: "b.ts" }],
      files: { "a.ts": "A", "b.ts": "B" },
    });
    let opens = 0;
    const access: CodeAccess = {
      kind: "ready",
      repo: REPO,
      provider: "github",
      open: async () => {
        opens++;
        return openRepoView(r.files, REPO);
      },
    };
    const read = lazyCodeReader(access);
    expect(opens).toBe(0);
    expect(await read?.("a.ts")).toBe("A");
    expect(await read?.("b.ts")).toBe("B");
    expect(opens).toBe(1);
    expect(r.trees()).toBe(1);
    expect(
      lazyCodeReader({ kind: "gap", gap: noRepositoryGap() }),
    ).toBeUndefined();
  });
});

describe("repoLabel", () => {
  test("bare path on github.com, host-prefixed elsewhere", () => {
    expect(
      repoLabel({ provider: "github", host: "github.com", path: REPO }),
    ).toBe(REPO);
    expect(
      repoLabel({
        provider: "gitlab",
        host: "gitlab.com",
        path: "grupo/loja-exemplo",
      }),
    ).toBe("gitlab.com/grupo/loja-exemplo");
  });
});

describe("gaps", () => {
  const providerError = (status: number, retryAfterMs: number | null = null) =>
    new GitProviderError({
      provider: "github",
      status,
      message: `provider said ${status}`,
      retryAfterMs,
    });

  test("no repository on the site project: the customer links one", () => {
    expect(noRepositoryGap()).toEqual({
      source: "github",
      error: `${CODE_UNAVAILABLE}: o projeto do site no Studio não tem repositório ligado`,
      owner: "customer",
      key: "repository",
    });
  });

  test("a repository this org did not link: the customer's, asking for the repository", () => {
    expect(notLinkedGap(REPO)).toEqual({
      source: "github",
      error: `${CODE_UNAVAILABLE}: o repositório ${REPO} não está ligado a esta org no Studio`,
      owner: "customer",
      key: "repository",
    });
  });

  test("a CodeGapError carries its own gap", () => {
    const gap = notLinkedGap(REPO);
    expect(codeGapOf(new CodeGapError(gap), "snapshot do repo", REPO)).toBe(
      gap,
    );
  });

  test("a dead provider credential asks the customer to reconnect that provider", () => {
    const gap = codeGapOf(
      providerError(401),
      "snapshot do repo",
      "gitlab.com/grupo/loja-exemplo",
      "gitlab",
    );
    expect(gap).toEqual({
      source: "github",
      error: `${CODE_UNAVAILABLE}: a conexão do Studio com o GitLab não lê mais o repositório gitlab.com/grupo/loja-exemplo: reconecte o GitLab no Studio`,
      owner: "customer",
      key: "repository",
    });
    expect(
      codeGapOf(providerError(403), "snapshot do repo", REPO).error,
    ).toContain("reconecte o GitHub no Studio");
  });

  test("a rate limit is external, with the provider's wait, even on a 403", () => {
    const limited = codeGapOf(
      providerError(429, 29_500),
      "snapshot do repo",
      REPO,
    );
    expect(limited.owner).toBe("external");
    expect(limited.key).toBeUndefined();
    expect(limited.error).toBe(
      `${CODE_UNAVAILABLE}: o GitHub limitou as leituras do repositório ${REPO} (de novo em 30s)`,
    );
    const secondary = codeGapOf(
      providerError(403, 60_000),
      "snapshot do repo",
      REPO,
    );
    expect(secondary.owner).toBe("external");
    expect(secondary.error).toContain("(de novo em 60s)");
    expect(
      codeGapOf(providerError(429), "snapshot do repo", REPO).error,
    ).not.toContain("de novo em");
  });

  test("anything else is ours, under the step's name", () => {
    expect(codeGapOf(providerError(502), `tema do repo ${REPO}`, REPO)).toEqual(
      {
        source: "github",
        error: `tema do repo ${REPO}: provider said 502`,
      },
    );
    expect(codeGapOf(new Error("boom"), "snapshot do repo", REPO)).toEqual({
      source: "github",
      error: "snapshot do repo: boom",
    });
    expect(codeGapOf("texto", "snapshot do repo", REPO).error).toBe(
      "snapshot do repo: texto",
    );
  });

  test("why a linked repository cannot be read", () => {
    for (const reason of ["no_account", "account_revoked", "auth_failed"]) {
      const gap = unusableGap(reason, "github", REPO);
      expect(gap.owner).toBe("customer");
      expect(gap.key).toBe("repository");
      expect(gap.error).toContain("reconecte o GitHub no Studio");
    }
    expect(unusableGap("auth_failed", "bitbucket", REPO).error).toContain(
      "reconecte o Bitbucket no Studio",
    );
    const missing = unusableGap("not_found", "github", REPO);
    expect(missing.owner).toBe("customer");
    expect(missing.error).toContain(`não acha o repositório ${REPO}`);
    const unconfigured = unusableGap("provider_unconfigured", "bitbucket", "r");
    expect(unconfigured.owner).toBeUndefined();
    expect(unconfigured.error).toContain("Bitbucket");
    expect(unusableGap("other", "github", REPO).owner).toBeUndefined();
  });
});
