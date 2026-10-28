import { describe, expect, test } from "bun:test";
import { cardPatchRefusal } from "./cards";

const CARD = {
  threadId: "thrd_card",
  branch: undefined,
  virtualMcpId: "vmcp_1",
};

describe("cardPatchRefusal", () => {
  test("a person may move a card anywhere but generating", () => {
    for (const status of [
      "ideas",
      "awaiting_review",
      "scheduled",
      "published",
    ] as const) {
      expect(cardPatchRefusal(CARD, { status }, null)).toBeNull();
    }
    expect(cardPatchRefusal(CARD, { status: "generating" }, null)).toContain(
      "BLOG_CARD_RUN",
    );
  });

  test("the card's own run fills it and hands it back for review", () => {
    expect(
      cardPatchRefusal(
        CARD,
        { status: "awaiting_review", stage: "done" },
        "thrd_card",
      ),
    ).toBeNull();
    expect(
      cardPatchRefusal(CARD, { hypothesis: { title: "T" } }, "thrd_card"),
    ).toBeNull();
  });

  test("a run never schedules, publishes or starts generating", () => {
    for (const status of ["scheduled", "published", "generating"] as const) {
      expect(cardPatchRefusal(CARD, { status }, "thrd_card")).not.toBeNull();
    }
  });

  test("a run writes only its own card", () => {
    expect(cardPatchRefusal(CARD, { error: "x" }, "thrd_other")).toContain(
      "another chat",
    );
    expect(
      cardPatchRefusal({ ...CARD, threadId: undefined }, { error: "x" }, "t"),
    ).not.toBeNull();
  });

  test("the site changes only until the card's branch is cut", () => {
    expect(cardPatchRefusal(CARD, { virtualMcpId: "vmcp_2" }, null)).toBeNull();
    const cut = { ...CARD, branch: "blog-aurora-1" };
    expect(cardPatchRefusal(cut, { virtualMcpId: "vmcp_2" }, null)).toContain(
      "branch",
    );
    expect(cardPatchRefusal(cut, { virtualMcpId: "vmcp_1" }, null)).toBeNull();
  });
});
