import { describe, expect, test } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import { OrgFsNotFoundError } from "../../file-storage/org-fs";
import { BLOG_POST_ILLUSTRATE } from "./post-illustrate";

const CARD_ID = "card0000abcd";
const CARD_PATH = `brands/acme/cards/${CARD_ID}.json`;
const CARD = {
  kind: "blogpost",
  status: "generating",
  virtualMcpId: "vmcp_1",
  threadId: "thrd_card",
  createdBy: "user_1",
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
};
const MARKED = { metadata: { blogCard: { cardId: CARD_ID, brand: "acme" } } };

/** The context a call arrives with: a person, or a run on `threadId`, whose thread carries `metadata`. */
function contextFor(
  threadId: string | null,
  threads: Record<string, unknown> = {},
): StudioContext {
  return {
    auth: { user: { id: "user_1" } },
    organization: { id: "org_1", slug: "acme" },
    access: { check: async () => {} },
    metadata: threadId ? { threadId } : undefined,
    storage: {
      organizationSettings: {
        get: async () => ({ flags: { blog_ai_enabled: true } }),
      },
      threads: { get: async (id: string) => threads[id] ?? null },
    },
    orgFs: {
      listDir: async () => [],
      read: async (_volume: string, path: string) => {
        if (path === CARD_PATH) {
          return new TextEncoder().encode(JSON.stringify(CARD));
        }
        throw new OrgFsNotFoundError(path);
      },
    },
  } as unknown as StudioContext;
}

const input = {
  requests: [{ id: "cover", prompt: "A backpack on a desk", alt: "" }],
  productImages: [],
  companyName: "",
  guidance: "",
} as Parameters<typeof BLOG_POST_ILLUSTRATE.handler>[0];

describe("BLOG_POST_ILLUSTRATE", () => {
  test("a person cannot draw a card's images", async () => {
    await expect(
      BLOG_POST_ILLUSTRATE.handler(input, contextFor(null)),
    ).rejects.toThrow("own run");
  });

  test("a chat with no card cannot either", async () => {
    await expect(
      BLOG_POST_ILLUSTRATE.handler(
        input,
        contextFor("thrd_chat", { thrd_chat: { metadata: {} } }),
      ),
    ).rejects.toThrow("no blogpost card");
  });

  test("a chat marked with a card it does not run cannot either", async () => {
    await expect(
      BLOG_POST_ILLUSTRATE.handler(
        input,
        contextFor("thrd_other", { thrd_other: MARKED }),
      ),
    ).rejects.toThrow("not the run");
  });

  test("the card's own run gets through, and with no bucket draws nothing", async () => {
    const result = await BLOG_POST_ILLUSTRATE.handler(
      input,
      contextFor("thrd_card", { thrd_card: MARKED }),
    );
    expect(result.outcome).toBe("no-bucket");
    expect(result.images).toEqual([{ id: "cover", url: "" }]);
  });
});
