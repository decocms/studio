import { describe, expect, test } from "bun:test";
import type { BlogCard } from "@decocms/shared/blog-card";
import {
  blogCardRunInstructions,
  blogCardRunPrompt,
  blogCardThreadId,
  cardRunInFlight,
  phaseClaim,
} from "./card-run";

const CARD: BlogCard = {
  id: "aurora-1",
  kind: "blogpost",
  status: "ideas",
  virtualMcpId: "vmcp_1",
  campaignId: "camp_1",
  createdBy: "user_1",
  createdAt: "2026-10-28T10:00:00.000Z",
  updatedAt: "2026-10-28T10:00:00.000Z",
};

const CLAIM = {
  threadId: "thrd_card",
  requestedAt: "2026-10-28T11:00:00.000Z",
  requestedBy: "user_1",
};

const NOW = Date.parse(CLAIM.requestedAt);

describe("blogCardThreadId", () => {
  test("is fixed per card and organization", () => {
    expect(blogCardThreadId("org_1", "aurora-1")).toBe(
      blogCardThreadId("org_1", "aurora-1"),
    );
    expect(blogCardThreadId("org_1", "aurora-1")).not.toBe(
      blogCardThreadId("org_2", "aurora-1"),
    );
    expect(blogCardThreadId("org_1", "aurora-1")).toMatch(
      /^thrd_[0-9a-f]{32}$/,
    );
  });
});

describe("cardRunInFlight", () => {
  const run = { phase: "hypothesis" as const, ...CLAIM };

  test("a running chat is in flight", () => {
    expect(cardRunInFlight(undefined, { status: "in_progress" }, NOW)).toBe(
      true,
    );
  });

  test("a run requested moments ago and not started yet is in flight", () => {
    expect(cardRunInFlight(run, { status: "completed" }, NOW + 30_000)).toBe(
      true,
    );
    expect(cardRunInFlight(run, null, NOW + 30_000)).toBe(true);
  });

  test("once the requested run started, its chat decides", () => {
    const finished = {
      status: "completed",
      run_started_at: "2026-10-28T11:00:05.000Z",
    };
    expect(cardRunInFlight(run, finished, NOW + 30_000)).toBe(false);
  });

  test("a request that never started stops counting after two minutes", () => {
    expect(cardRunInFlight(run, { status: "failed" }, NOW + 120_000)).toBe(
      false,
    );
  });

  test("a card that never ran is idle", () => {
    expect(cardRunInFlight(undefined, null, NOW)).toBe(false);
  });
});

describe("phaseClaim", () => {
  test("a hypothesis claims a card in ideas and clears its last error", () => {
    const claimed = phaseClaim(
      { ...CARD, error: "timeout" },
      "hypothesis",
      CLAIM,
    );
    expect(claimed).toMatchObject({
      status: "ideas",
      threadId: "thrd_card",
      run: { phase: "hypothesis", requestedAt: CLAIM.requestedAt },
      updatedAt: CLAIM.requestedAt,
    });
    expect("error" in claimed).toBe(false);
  });

  test("a hypothesis is not brought again past ideas", () => {
    expect(() =>
      phaseClaim({ ...CARD, status: "awaiting_review" }, "hypothesis", CLAIM),
    ).toThrow("ideas");
  });

  test("an execution needs a campaign and a thesis", () => {
    expect(() => phaseClaim(CARD, "execute", CLAIM)).toThrow("hypothesis");
    expect(() =>
      phaseClaim(
        {
          ...CARD,
          campaignId: undefined,
          hypothesis: { statement: "Tese" },
        },
        "execute",
        CLAIM,
      ),
    ).toThrow("campaign");
  });

  test("an execution moves the card to generating on its own branch", () => {
    const claimed = phaseClaim(
      {
        ...CARD,
        hypothesis: { statement: "Tese" },
        post: { title: "Velho" },
        commit: "abc",
      },
      "execute",
      { ...CLAIM, fileConfigId: "fc_1" },
    );
    expect(claimed).toMatchObject({
      status: "generating",
      stage: "grounding",
      branch: "blog-aurora-1",
      fileConfigId: "fc_1",
      hypothesis: { statement: "Tese" },
    });
    expect("post" in claimed).toBe(false);
    expect("commit" in claimed).toBe(false);
  });

  test("a scheduled or published card is not written again", () => {
    for (const status of ["scheduled", "published"] as const) {
      expect(() =>
        phaseClaim(
          { ...CARD, status, hypothesis: { statement: "Tese" } },
          "execute",
          CLAIM,
        ),
      ).toThrow("awaiting review");
    }
  });
});

describe("blogCardRunInstructions", () => {
  const text = blogCardRunInstructions({
    id: "aurora-1",
    virtualMcpId: "vmcp_1",
    brand: "acme",
  });

  test("names the card, the site, the skill and the card's branch", () => {
    expect(text).toContain("`aurora-1`");
    expect(text).toContain("home/brands/acme/");
    expect(text).toContain("`vmcp_1`");
    expect(text).toContain("`blogpost` skill");
    expect(text).toContain("`blog-aurora-1`");
  });

  test("keeps publishing a person's", () => {
    expect(text).toContain("never publish");
    expect(text).toContain("mcp__studio__BLOG_CARD_UPDATE");
  });
});

describe("blogCardRunPrompt", () => {
  test("ends with the person's words when there are any", () => {
    expect(blogCardRunPrompt("hypothesis", "  sofás pequenos ")).toEndWith(
      "From the person:\nsofás pequenos",
    );
    expect(blogCardRunPrompt("execute", "   ")).not.toContain(
      "From the person",
    );
  });

  test("each phase points at its own file", () => {
    expect(blogCardRunPrompt("hypothesis", undefined)).toContain(
      "hypothesis.md",
    );
    expect(blogCardRunPrompt("execute", undefined)).toContain("execute.md");
  });
});
