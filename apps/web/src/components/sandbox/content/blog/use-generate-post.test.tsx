import { setupComponentTest } from "../../../../../test/setup";
setupComponentTest();
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook } from "@testing-library/react";

/**
 * One generation run writes several posts onto several keys, one save at a
 * time. The question these cover is what happens to the saves that already
 * landed when a later one does not: a finished post, with its sections, its
 * slug and a cover already uploaded to the org's bucket, must survive a failure
 * that arrives after it. The first version of the multi-draft loop reset every
 * key from zero, so the third save failing destroyed the first two.
 */

interface Write {
  blockKey: string;
  title: string;
}

const writes: Write[] = [];
/** Which save call rejects, 1-based. 0 means every save succeeds. */
let failOnCall = 0;
let calls = 0;

const titleOf = (data: Record<string, unknown>): string => {
  const payload = Object.values(data).find(
    (value) => value && typeof value === "object",
  ) as Record<string, unknown> | undefined;
  return typeof payload?.title === "string" ? payload.title : "";
};

const mutateAsync = mock(
  async (args: { blockKey: string; data: Record<string, unknown> }) => {
    calls += 1;
    if (calls === failOnCall) throw new Error("sandbox said no");
    writes.push({ blockKey: args.blockKey, title: titleOf(args.data) });
    return args;
  },
);

/** Which tools the run reached, in order, so the sequence itself is testable. */
const toolCalls: string[] = [];

const DRAFTS = ["Post um", "Post dois", "Post três"].map((title) => ({
  title,
  excerpt: "",
  seo: { title: "", description: "" },
  cover: { url: "", alt: "capa", prompt: "uma mochila na mesa" },
  categorySlugs: [],
  authorEmails: [],
  sections: [],
}));

const studioCall = mock(
  async (name: string, input: Record<string, unknown>) => {
    toolCalls.push(name);
    if (name === "BLOG_SITE_GROUND") {
      return {
        report: "a loja vende mochilas",
        outcome: "ok",
        toolNames: ["search"],
        evidence: "",
        evidenceUri: null,
        evidenceChars: 0,
      };
    }
    if (name === "BLOG_POST_ILLUSTRATE") {
      const requests = input.requests as { id: string }[];
      return {
        images: requests.map((request) => ({
          id: request.id,
          url: `https://cdn.example.com/${request.id}.png`,
        })),
        outcome: "ok",
        referenced: 2,
      };
    }
    return { posts: DRAFTS, gaps: [] };
  },
);

mock.module("@/components/sections-editor/use-save-block", () => ({
  useSaveBlock: () => ({ mutateAsync, isPending: false }),
}));
mock.module("@/lib/studio-tools", () => ({
  useStudioTools: () => ({ orgSlug: "org", call: studioCall }),
}));
mock.module("@/hooks/use-hide-default-blog-blocks", () => ({
  useHideDefaultBlogBlocks: () => false,
}));
mock.module("@/i18n/use-t.ts", () => ({ useT: () => (key: string) => key }));
mock.module("sonner", () => ({
  toast: { success: () => {}, error: () => {}, warning: () => {} },
}));

const { useGeneratePost } = await import("./use-generate-post");

const BRIEFING = {
  campaign: {
    key: "campaign-1",
    name: "A campanha",
    status: "active",
    period: { start: null, end: null },
    trigger: { type: "date", note: "Volta às aulas" },
    intent: {
      objective: "awareness",
      targets: [],
      products: [
        {
          id: "150298",
          name: "Mochila",
          url: "",
          category: "Escolar",
          description: "",
          images: ["https://cdn.example.com/mochila-1.jpg"],
        },
      ],
      keywords: [],
    },
    guardrails: { avoidComplements: [], toneOverrides: "" },
  },
  format: { name: "Guia", value: "Um guia" },
  count: 3,
};

/** The keys are minted per run, so identity comes from write order. */
const keysInOrder = () => [...new Set(writes.map((write) => write.blockKey))];

describe("useGeneratePost", () => {
  const runWithBucket = () => {
    const { result } = renderHook(() =>
      useGeneratePost({
        orgSlug: "org",
        virtualMcpId: "vmcp",
        branch: "main",
        decofile: {},
        meta: { schema: { definitions: {} } } as never,
      }),
    );
    return result.current({ ...BRIEFING, fileConfigId: "bucket-1" } as never);
  };

  const run = () => {
    const { result } = renderHook(() =>
      useGeneratePost({
        orgSlug: "org",
        virtualMcpId: "vmcp",
        branch: "main",
        decofile: {},
        meta: { schema: { definitions: {} } } as never,
      }),
    );
    return result.current(BRIEFING as never);
  };

  beforeEach(() => {
    writes.length = 0;
    toolCalls.length = 0;
    calls = 0;
    failOnCall = 0;
  });

  test("reads the store in its own call before drafting", async () => {
    await run();
    expect(toolCalls.indexOf("BLOG_SITE_GROUND")).toBeLessThan(
      toolCalls.indexOf("BLOG_POST_DRAFT"),
    );
  });

  /** Without a bucket there is nowhere to put an image, so none is drawn. */
  test("does not illustrate when the briefing names no bucket", async () => {
    await run();
    expect(toolCalls).not.toContain("BLOG_POST_ILLUSTRATE");
  });

  test("writes one placeholder per requested draft, then one post each", async () => {
    await run();
    const keys = keysInOrder();
    expect(keys).toHaveLength(3);
    expect(writes.filter((write) => write.blockKey === keys[0])).toEqual([
      { blockKey: keys[0]!, title: "A campanha" },
      { blockKey: keys[0]!, title: "Post um" },
    ]);
  });

  /**
   * The cover is drawn after the words, by its own call, and conditioned on the
   * product's own photographs — a post about a backpack illustrated with one
   * the brand does not sell is worse than one with no picture.
   */
  test("takes the cover from the illustrating call, not from the draft", async () => {
    await runWithBucket();
    expect(toolCalls).toContain("BLOG_POST_ILLUSTRATE");
    expect(toolCalls.indexOf("BLOG_POST_DRAFT")).toBeLessThan(
      toolCalls.indexOf("BLOG_POST_ILLUSTRATE"),
    );
  });

  test("offers the campaign's product photographs as references", async () => {
    await runWithBucket();
    const drawn = studioCall.mock.calls.find(
      ([name]) => name === "BLOG_POST_ILLUSTRATE",
    );
    expect(drawn?.[1].productImages).toEqual([
      "https://cdn.example.com/mochila-1.jpg",
    ]);
  });

  test("a save that fails after two posts landed does not erase them", async () => {
    // 3 placeholders, then post one, post two, and the sixth call fails.
    failOnCall = 6;
    await run();

    const keys = keysInOrder();
    const lastFor = (key: string) =>
      writes.filter((write) => write.blockKey === key).at(-1)?.title;

    expect(lastFor(keys[0]!)).toBe("Post um");
    expect(lastFor(keys[1]!)).toBe("Post dois");
  });

  test("the card whose post never arrived is returned to the board", async () => {
    failOnCall = 6;
    await run();

    const keys = keysInOrder();
    const third = writes.filter((write) => write.blockKey === keys[2]!);
    expect(third.at(-1)?.title).toBe("A campanha");
  });

  test("a failed run never rejects, since the caller fires and forgets it", async () => {
    failOnCall = 4;
    expect(run()).resolves.toBeUndefined();
  });

  test("a placeholder that never landed is not resurrected as an empty card", async () => {
    failOnCall = 2;
    await run();
    expect(keysInOrder()).toHaveLength(1);
  });
});
