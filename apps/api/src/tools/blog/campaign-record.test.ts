import { describe, expect, test } from "bun:test";
import {
  agentStateWriteRefusal,
  applyCampaignPatch,
  type CampaignPatch,
  campaignPatchRefusal,
  campaignShell,
} from "./campaign-record";

const DEVELOPED = {
  campaignName: "Volta às aulas",
  status: "draft",
  threadId: "thrd_card",
  trigger: { type: "seasonal", note: "As aulas voltam em fevereiro." },
};
const NOW = "2026-10-30T00:00:00.000Z";

describe("campaignPatchRefusal", () => {
  test("the campaign's own chat writes what it develops", () => {
    expect(
      campaignPatchRefusal(DEVELOPED, { campaignName: "Novo" }, "thrd_card"),
    ).toBeNull();
  });

  test("another chat may not write it", () => {
    expect(
      campaignPatchRefusal(DEVELOPED, { campaignName: "Novo" }, "thrd_other"),
    ).toContain("shaped elsewhere");
    expect(
      campaignPatchRefusal(
        { campaignName: "x" },
        { campaignName: "y" },
        "thrd_card",
      ),
    ).toContain("shaped elsewhere");
  });

  test("an agent never sends the goals or the status", () => {
    const patch: CampaignPatch = { status: "active" };
    expect(campaignPatchRefusal(DEVELOPED, patch, "thrd_card")).toContain(
      "a person's",
    );
    expect(
      campaignPatchRefusal(DEVELOPED, { goals: [] }, "thrd_card"),
    ).toContain("a person's");
  });

  test("a person sets only the goals and the status", () => {
    expect(
      campaignPatchRefusal(
        DEVELOPED,
        { goals: [{ text: "Crescer", metric: "sessions", target: "+20%" }] },
        null,
      ),
    ).toBeNull();
    expect(
      campaignPatchRefusal(DEVELOPED, { campaignName: "Outro" }, null),
    ).toContain("campaign's chat");
  });

  test("a person approves a developed draft, never an undeveloped one", () => {
    expect(
      campaignPatchRefusal(DEVELOPED, { status: "active" }, null),
    ).toBeNull();
    expect(
      campaignPatchRefusal(
        { campaignName: "", status: "draft" },
        { status: "active" },
        null,
      ),
    ).toContain("develops a campaign");
  });

  test("an approved campaign never goes back to draft", () => {
    expect(
      campaignPatchRefusal(
        { ...DEVELOPED, status: "active" },
        { status: "draft" },
        null,
      ),
    ).toContain("never sent back");
    expect(
      campaignPatchRefusal(
        { ...DEVELOPED, status: "active" },
        { status: "paused" },
        null,
      ),
    ).toBeNull();
  });
});

describe("applyCampaignPatch", () => {
  test("objects merge, arrays replace, null removes, unknown fields stay", () => {
    const stored = {
      ...DEVELOPED,
      cmsOnly: "kept",
      intent: {
        objective: "conversion",
        targets: [],
        products: [
          {
            id: "1",
            name: "A",
            url: "",
            images: [],
            category: "",
            description: "",
          },
        ],
        keywords: ["mochila"],
      },
      briefing: { text: "Mochilas" },
    };
    const next = applyCampaignPatch(
      stored,
      { intent: { keywords: ["lancheira"] }, briefing: null },
      NOW,
    );
    expect(next.cmsOnly).toBe("kept");
    expect((next.intent as Record<string, unknown>).keywords).toEqual([
      "lancheira",
    ]);
    expect(
      ((next.intent as Record<string, unknown>).products as unknown[]).length,
    ).toBe(1);
    expect("briefing" in next).toBe(false);
    expect(next.updatedAt).toBe(NOW);
  });

  test("goals land on an old record whose other fields are incomplete, and its single goal goes", () => {
    const legacy = {
      campaignName: "Antiga",
      status: "active",
      intent: { objective: "nope" },
      goal: { text: "Antiga meta", metric: null, target: "" },
    };
    const goals = [
      { text: "Crescer", metric: null, target: "" },
      { text: "Vender", metric: "revenue" as const, target: "+10%" },
    ];
    const next = applyCampaignPatch(legacy, { goals }, NOW);
    expect(next.goals).toEqual(goals);
    expect("goal" in next).toBe(false);
  });

  test("more goals than a campaign keeps are refused", () => {
    const goal = { text: "x", metric: null, target: "" };
    expect(() =>
      applyCampaignPatch(DEVELOPED, { goals: Array(6).fill(goal) }, NOW),
    ).toThrow();
  });

  test("evidence carries each figure's detail, and refuses one that cannot be drawn", () => {
    const evidence: CampaignPatch["evidence"] = [
      {
        source: "gsc",
        figure: "22.140 impressões",
        fact: "Ninguém clica.",
        detail: {
          trend: { points: [3100, 3400, 3900] },
          link: { url: "https://search.google.com/search-console" },
        },
      },
    ];
    const next = applyCampaignPatch(DEVELOPED, { evidence }, NOW);
    expect(next.evidence).toEqual(evidence);
    expect(() =>
      applyCampaignPatch(
        DEVELOPED,
        {
          evidence: [
            { source: "gsc", fact: "x", detail: { trend: { points: [1] } } },
          ],
        },
        NOW,
      ),
    ).toThrow();
  });

  test("a touched field that is invalid once merged is refused", () => {
    const legacy = {
      campaignName: "Antiga",
      intent: { objective: "awareness" },
    };
    expect(() =>
      applyCampaignPatch(legacy, { intent: { keywords: ["x"] } }, NOW),
    ).toThrow("`intent` is not valid");
  });
});

describe("campaignShell", () => {
  test("a draft with no name yet, naming the chat that shapes it", () => {
    const run = { requestedAt: NOW, requestedBy: "user_1" };
    expect(campaignShell("thrd_1", run, NOW)).toMatchObject({
      campaignName: "",
      status: "draft",
      threadId: "thrd_1",
      run,
    });
    expect(
      campaignShell("thrd_1", run, NOW, { text: "Mochilas" }).briefing,
    ).toEqual({ text: "Mochilas" });
  });
});

describe("agentStateWriteRefusal", () => {
  const none = { campaigns: 0, seeds: 0, removals: 0 };

  test("a person writes the blog state as before", () => {
    expect(agentStateWriteRefusal(null, { ...none, campaigns: 2 })).toBeNull();
  });

  test("a chat changes campaigns elsewhere, and never seeds or removals", () => {
    expect(
      agentStateWriteRefusal("thrd_1", { ...none, campaigns: 1 }),
    ).toContain("BLOG_CAMPAIGN_UPDATE");
    expect(agentStateWriteRefusal("thrd_1", { ...none, seeds: 1 })).toContain(
      "a person's",
    );
    expect(
      agentStateWriteRefusal("thrd_1", { ...none, removals: 1 }),
    ).toContain("a person's");
    expect(agentStateWriteRefusal("thrd_1", none)).toBeNull();
  });
});
