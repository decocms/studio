import { describe, expect, test } from "bun:test";
import { blogCampaignInstructions, blogCampaignPrompt } from "./campaigns";

describe("blogCampaignInstructions", () => {
  test("pins the campaign, the skill, its goals and who approves it", () => {
    const text = blogCampaignInstructions({
      brand: "aurora",
      campaignId: "c1",
    });
    expect(text).toContain("`c1`");
    expect(text).toContain("home/brands/aurora/");
    expect(text).toContain("`campaigns.md`");
    expect(text).toContain("mcp__studio__BLOG_CAMPAIGN_UPDATE");
    expect(text).toContain("its goals included");
    expect(text).toContain("Never send `status`");
  });
});

describe("blogCampaignPrompt", () => {
  test("each step asks for its own work", () => {
    expect(blogCampaignPrompt("suggest")).toContain("briefings");
    expect(blogCampaignPrompt("develop")).toContain("chosen briefing");
    expect(blogCampaignPrompt("adjust")).toContain("keeping its status");
  });

  test("the person's words follow the ask, when there are any", () => {
    expect(blogCampaignPrompt("adjust", "Troque os produtos")).toEndWith(
      "From the person:\nTroque os produtos",
    );
    expect(blogCampaignPrompt("suggest", "   ")).not.toContain(
      "From the person",
    );
  });
});
