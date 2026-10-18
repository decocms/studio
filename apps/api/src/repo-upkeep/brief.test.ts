import { describe, expect, test } from "bun:test";
import type { RepoInsightsClient } from "@/git-providers";
import { parseModelJson } from "@/core/fast-tier-json";
import {
  type BriefDeps,
  buildBrief,
  RepositoryBriefSchema,
  rootFile,
  summarizeTree,
} from "./brief";

const NOW = new Date("2026-10-18T12:00:00Z");
const BRIEF = {
  purpose: "Storefront for a fashion brand.",
  activeAreas: ["sections/ — new PDP"],
  abandonedAreas: [],
  conventions: ["Conventional commits"],
};

function fakeClient(opts: { headSha?: string | null; readme?: boolean }) {
  const calls: string[] = [];
  const client = {
    repo: { provider: "github", host: "github.com", path: "acme/site" },
    capabilities: () => ({}),
    listCommits: async () => {
      calls.push("commits");
      return {
        items:
          opts.headSha === null
            ? []
            : [
                {
                  sha: opts.headSha ?? "abc",
                  date: "2026-10-17T10:00:00Z",
                  message: "feat: pdp",
                  author: { name: "a", email: null, login: "a" },
                },
              ],
        nextCursor: null,
      };
    },
    listTree: async () => {
      calls.push("tree");
      return {
        ref: "main",
        truncated: false,
        entries: [
          { path: "sections", type: "tree" as const },
          { path: "sections/Pdp.tsx", type: "blob" as const },
          { path: "AGENTS.md", type: "blob" as const },
          ...(opts.readme === false
            ? []
            : [{ path: "README.md", type: "blob" as const }]),
        ],
      };
    },
    readFile: async ({ path }: { path: string }) => {
      calls.push(`read:${path}`);
      return { content: `contents of ${path}`, size: 10, truncated: false };
    },
    listChangeRequests: async () => {
      calls.push("merged");
      return {
        items: [
          { number: 9, title: "New PDP", mergedAt: "2026-10-16T00:00:00Z" },
        ],
        nextCursor: null,
      };
    },
  } as unknown as RepoInsightsClient;
  return { client, calls };
}

function deps(answer: Awaited<ReturnType<BriefDeps["ask"]>>) {
  const prompts: string[] = [];
  const d: BriefDeps = {
    ask: async (_system, prompt) => {
      prompts.push(prompt);
      return answer;
    },
    readOrgMemory: async () => "We sell clothes.",
  };
  return { d, prompts };
}

describe("buildBrief", () => {
  test("builds from commits, tree, README, guide, merged history, and org notes", async () => {
    const { client, calls } = fakeClient({});
    const { d, prompts } = deps({ answer: BRIEF });
    const outcome = await buildBrief(client, null, NOW, d);
    expect(outcome).toEqual({ kind: "built", headSha: "abc", brief: BRIEF });
    expect(calls.sort()).toEqual(
      ["commits", "merged", "read:AGENTS.md", "read:README.md", "tree"].sort(),
    );
    expect(prompts[0]).toContain("contents of README.md");
    expect(prompts[0]).toContain("#9 New PDP");
    expect(prompts[0]).toContain("We sell clothes.");
  });

  test("an unmoved branch costs one read and no model call", async () => {
    const { client, calls } = fakeClient({ headSha: "abc" });
    const { d, prompts } = deps({ answer: BRIEF });
    const outcome = await buildBrief(
      client,
      { headSha: "abc", built: true },
      NOW,
      d,
    );
    expect(outcome).toEqual({ kind: "unchanged", headSha: "abc" });
    expect(calls).toEqual(["commits"]);
    expect(prompts).toHaveLength(0);
  });

  test("a previous failure with the same head still builds", async () => {
    const { client } = fakeClient({ headSha: "abc" });
    const { d } = deps({ answer: BRIEF });
    const outcome = await buildBrief(
      client,
      { headSha: "abc", built: false },
      NOW,
      d,
    );
    expect(outcome.kind).toBe("built");
  });

  test("a quiet repository with no README still builds", async () => {
    const { client, calls } = fakeClient({ headSha: null, readme: false });
    const { d, prompts } = deps({ answer: BRIEF });
    const outcome = await buildBrief(client, null, NOW, d);
    expect(outcome).toEqual({ kind: "built", headSha: null, brief: BRIEF });
    expect(calls).not.toContain("read:README.md");
    expect(prompts[0]).toContain("README: (none)");
  });

  test("a skipped model call is reported, not stored as a brief", async () => {
    const { client } = fakeClient({});
    const { d } = deps({ skipped: "no provider" });
    expect(await buildBrief(client, null, NOW, d)).toEqual({
      kind: "skipped",
      reason: "no provider",
    });
  });

  test("org notes that cannot be read do not fail the build", async () => {
    const { client } = fakeClient({});
    const { d } = deps({ answer: BRIEF });
    d.readOrgMemory = async () => {
      throw new Error("not found");
    };
    expect((await buildBrief(client, null, NOW, d)).kind).toBe("built");
  });

  test("a provider failure propagates for the caller to record", async () => {
    const { client } = fakeClient({});
    client.listTree = async () => {
      throw new Error("403");
    };
    const { d } = deps({ answer: BRIEF });
    await expect(buildBrief(client, null, NOW, d)).rejects.toThrow("403");
  });
});

describe("RepositoryBriefSchema", () => {
  test("clamps oversized lists and items instead of rejecting them", () => {
    const parsed = parseModelJson(
      JSON.stringify({
        purpose: "x".repeat(900),
        activeAreas: Array.from({ length: 20 }, (_, i) => `area ${i}`),
        abandonedAreas: ["", "  old/  "],
        conventions: ["y".repeat(500)],
      }),
      RepositoryBriefSchema,
    );
    expect(parsed?.purpose).toHaveLength(600);
    expect(parsed?.activeAreas).toHaveLength(8);
    expect(parsed?.abandonedAreas).toEqual(["old/"]);
    expect(parsed?.conventions[0]).toHaveLength(200);
  });

  test("rejects an empty purpose", () => {
    expect(
      parseModelJson(
        '{"purpose":" ","activeAreas":[],"abandonedAreas":[],"conventions":[]}',
        RepositoryBriefSchema,
      ),
    ).toBeNull();
  });
});

describe("tree helpers", () => {
  const entries = [
    { path: "src/a.ts", type: "blob" as const },
    { path: "src/b.ts", type: "blob" as const },
    { path: "docs/x.md", type: "blob" as const },
    { path: "docs/README.md", type: "blob" as const },
    { path: "readme.MD", type: "blob" as const },
    { path: "src", type: "tree" as const },
  ];

  test("summarizeTree counts files per top-level directory", () => {
    expect(summarizeTree(entries)).toBe(
      "src/ (2 files)\ndocs/ (2 files)\nreadme.MD",
    );
  });

  test("rootFile matches only at the root", () => {
    expect(rootFile(entries, /^readme(\.\w+)?$/i)).toBe("readme.MD");
    expect(rootFile(entries, /^agents\.md$/i)).toBeNull();
  });
});
