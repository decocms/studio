import { describe, expect, test } from "bun:test";
import { type CampaignsJob, campaignsJobRefusal } from "./blog-job";

const job: CampaignsJob = {
  kind: "campaigns",
  brand: "aurora",
  seedId: "s1",
  campaignIds: ["c1", "c2"],
};
const draft = { status: "draft", seedKey: "blog-manager/campaign-seeds/s1" };
const none = new Map<string, Record<string, unknown> | null>();

function refusal(
  campaigns: { id: string; data: Record<string, unknown> }[],
  extra: { seeds?: number; removals?: number } = {},
  stored = none,
) {
  return campaignsJobRefusal(
    job,
    { campaigns, seeds: extra.seeds ?? 0, removals: extra.removals ?? 0 },
    stored,
  );
}

describe("campaignsJobRefusal", () => {
  test("its own drafts land, and an empty goal is no goal", () => {
    expect(refusal([{ id: "c1", data: draft }])).toBeNull();
    expect(
      refusal([
        {
          id: "c2",
          data: { ...draft, goal: { text: " ", metric: null, target: "" } },
        },
      ]),
    ).toBeNull();
  });

  test("another campaign's id is refused, naming the ones it may write", () => {
    expect(refusal([{ id: "c9", data: draft }])).toContain("`c1`, `c2`");
  });

  test("an active campaign, another seed or a goal is refused", () => {
    expect(
      refusal([{ id: "c1", data: { ...draft, status: "active" } }]),
    ).toContain('status: "draft"');
    expect(refusal([{ id: "c1", data: { ...draft, seedKey: "" } }])).toContain(
      "blog-manager/campaign-seeds/s1",
    );
    expect(
      refusal([{ id: "c1", data: { ...draft, goal: { metric: "sessions" } } }]),
    ).toContain("without a goal");
  });

  test("seeds and removals are a person's", () => {
    expect(refusal([], { seeds: 1 })).toContain("never writes a seed");
    expect(refusal([], { removals: 1 })).toContain("never removes");
  });

  test("a draft a person took over is left alone", () => {
    const activated = new Map([["c1", { ...draft, status: "active" }]]);
    expect(refusal([{ id: "c1", data: draft }], {}, activated)).toContain(
      "a person's now",
    );
    const withGoal = new Map([["c1", { ...draft, goal: { target: "+20%" } }]]);
    expect(refusal([{ id: "c1", data: draft }], {}, withGoal)).toContain(
      "a person's now",
    );
    const stillDraft = new Map([["c1", draft]]);
    expect(refusal([{ id: "c1", data: draft }], {}, stillDraft)).toBeNull();
  });
});
