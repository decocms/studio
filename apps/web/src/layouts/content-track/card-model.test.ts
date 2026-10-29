import { describe, expect, test } from "bun:test";
import type { BlogCard } from "@decocms/shared/blog-card";
import type { CampaignProduct } from "@/components/sandbox/content/blog/blog-data";
import {
  canDropOn,
  cardAgentWorking,
  cardTitle,
  defaultPhase,
  imageReady,
  shelfProducts,
  stageDone,
  upsertCard,
} from "./card-model";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");

function card(overrides: Partial<BlogCard> = {}): BlogCard {
  return {
    id: "aurora-1",
    kind: "blogpost",
    status: "ideas",
    virtualMcpId: "vmcp_1",
    createdBy: "user_1",
    createdAt: "2026-10-28T10:00:00.000Z",
    updatedAt: "2026-10-28T10:00:00.000Z",
    ...overrides,
  };
}

const RECENT_RUN = {
  phase: "hypothesis" as const,
  requestedAt: "2026-10-28T11:55:00.000Z",
  requestedBy: "user_1",
};

describe("cardAgentWorking", () => {
  test("a hypothesis not saved yet is being brought", () => {
    expect(cardAgentWorking(card({ run: RECENT_RUN }), NOW)).toBe(true);
    expect(
      cardAgentWorking(
        card({ run: RECENT_RUN, hypothesis: { statement: "Tese" } }),
        NOW,
      ),
    ).toBe(false);
  });

  test("an execution works until it is done", () => {
    const run = { ...RECENT_RUN, phase: "execute" as const };
    expect(
      cardAgentWorking(
        card({ run, status: "generating", stage: "drafting" }),
        NOW,
      ),
    ).toBe(true);
    expect(
      cardAgentWorking(card({ run, status: "generating", stage: "done" }), NOW),
    ).toBe(false);
    expect(
      cardAgentWorking(card({ run, status: "awaiting_review" }), NOW),
    ).toBe(false);
  });

  test("an error, no run, or a run gone quiet is not work", () => {
    expect(cardAgentWorking(card(), NOW)).toBe(false);
    expect(cardAgentWorking(card({ run: RECENT_RUN, error: "x" }), NOW)).toBe(
      false,
    );
    expect(
      cardAgentWorking(
        card({
          run: { ...RECENT_RUN, requestedAt: "2026-10-28T11:00:00.000Z" },
        }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("upsertCard", () => {
  test("replaces by id and keeps the newest change first", () => {
    const a = card({ id: "a", updatedAt: "2026-10-28T10:00:00.000Z" });
    const b = card({ id: "b", updatedAt: "2026-10-28T11:00:00.000Z" });
    const a2 = {
      ...a,
      status: "awaiting_review" as const,
      updatedAt: "2026-10-28T12:00:00.000Z",
    };
    expect(upsertCard([b, a], a2).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(upsertCard([b, a], a2)[0]?.status).toBe("awaiting_review");
  });

  test("drops a late echo older than what is held", () => {
    const held = card({
      updatedAt: "2026-10-28T12:00:00.000Z",
      status: "scheduled",
    });
    const late = card({ updatedAt: "2026-10-28T11:00:00.000Z" });
    expect(upsertCard([held], late)).toEqual([held]);
  });

  test("adds a card it did not have", () => {
    expect(upsertCard([], card()).map((entry) => entry.id)).toEqual([
      "aurora-1",
    ]);
  });
});

test("only generating refuses a drop", () => {
  expect(canDropOn("generating")).toBe(false);
  expect(canDropOn("ideas")).toBe(true);
  expect(canDropOn("published")).toBe(true);
});

test("a card opens on its hypothesis until execution began", () => {
  expect(defaultPhase(card())).toBe("hypothesis");
  expect(defaultPhase(card({ status: "generating" }))).toBe("execute");
  expect(defaultPhase(card({ status: "published" }))).toBe("execute");
});

test("a card's title: hypothesis, then post, then the ask", () => {
  expect(cardTitle(card({ prompt: "sofás\nmais" }))).toBe("sofás");
  expect(cardTitle(card({ prompt: "x", post: { title: "Post" } }))).toBe(
    "Post",
  );
  expect(
    cardTitle(card({ post: { title: "Post" }, hypothesis: { title: "Tese" } })),
  ).toBe("Tese");
  expect(cardTitle(card())).toBe("");
});

test("a stage is done once the card moved past it", () => {
  const drafting = card({ status: "generating", stage: "drafting" });
  expect(stageDone(drafting, "grounding")).toBe(true);
  expect(stageDone(drafting, "drafting")).toBe(false);
  expect(stageDone(card({ status: "awaiting_review" }), "writing")).toBe(true);
});

test("an illustrator's note is not an image", () => {
  expect(imageReady("https://cdn.example/cover.webp")).toBe(true);
  expect(imageReady("generate:a sofa")).toBe(false);
  expect(imageReady(" ")).toBe(false);
  expect(imageReady(undefined)).toBe(false);
});

test("a shelf shows the campaign's products in the block's order, once each", () => {
  const product = (id: string): CampaignProduct => ({
    id,
    name: `P${id}`,
    url: "",
    images: [],
    category: "",
    description: "",
  });
  const shown = shelfProducts(
    ["2", "9", "1", "2"],
    [product("1"), product("2")],
  );
  expect(shown.map((entry) => entry.id)).toEqual(["2", "1"]);
});
