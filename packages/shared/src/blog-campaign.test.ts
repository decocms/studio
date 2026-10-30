import { describe, expect, test } from "bun:test";
import {
  CampaignBriefingOptionSchema,
  CampaignBriefingSchema,
  campaignDeveloped,
  campaignNextStep,
} from "./blog-campaign";

describe("campaign briefings", () => {
  test("an option needs a title and an idea; its figure and source are optional", () => {
    expect(
      CampaignBriefingOptionSchema.safeParse({
        id: "b1",
        title: "Volta às aulas",
        idea: "Mochilas para quem volta em fevereiro.",
      }).success,
    ).toBe(true);
    expect(
      CampaignBriefingOptionSchema.safeParse({ id: "b1", title: "", idea: "x" })
        .success,
    ).toBe(false);
    expect(
      CampaignBriefingOptionSchema.safeParse({
        id: "b1",
        title: "T",
        idea: "I",
        source: "tiktok",
      }).success,
    ).toBe(false);
  });

  test("a chosen briefing is its text, trimmed, and never blank", () => {
    expect(CampaignBriefingSchema.parse({ text: "  Mochilas  " }).text).toBe(
      "Mochilas",
    );
    expect(CampaignBriefingSchema.safeParse({ text: "   " }).success).toBe(
      false,
    );
  });
});

describe("campaignDeveloped", () => {
  test("needs a name and a reason to run now", () => {
    expect(
      campaignDeveloped({
        campaignName: "Volta às aulas",
        trigger: { note: "Fevereiro." },
      }),
    ).toBe(true);
    expect(campaignDeveloped({ campaignName: "Volta às aulas" })).toBe(false);
    expect(
      campaignDeveloped({ campaignName: " ", trigger: { note: "x" } }),
    ).toBe(false);
  });
});

describe("campaignNextStep", () => {
  const shell = { campaignName: "", status: "draft" };

  test("a fresh draft gets briefings suggested", () => {
    expect(campaignNextStep(shell)).toBe("suggest");
  });

  test("with briefings on offer and none chosen, it waits for the person", () => {
    expect(
      campaignNextStep({
        ...shell,
        briefings: [{ id: "b1", title: "T", idea: "I" }],
      }),
    ).toBeNull();
  });

  test("a chosen briefing gets developed", () => {
    expect(
      campaignNextStep({
        ...shell,
        briefings: [{ id: "b1", title: "T", idea: "I" }],
        briefing: { text: "T", optionId: "b1" },
      }),
    ).toBe("develop");
  });

  test("a developed draft, or an approved campaign, has nothing to start", () => {
    expect(
      campaignNextStep({
        status: "draft",
        campaignName: "Volta às aulas",
        trigger: { note: "Fevereiro." },
      }),
    ).toBeNull();
    expect(campaignNextStep({ ...shell, status: "active" })).toBeNull();
  });
});
