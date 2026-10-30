import { describe, expect, test } from "bun:test";
import {
  blogCampaignsInstructions,
  blogCampaignsPrompt,
} from "./campaigns-propose";

describe("blogCampaignsInstructions", () => {
  test("pins the skill, the ids, the seed and the draft rules", () => {
    const text = blogCampaignsInstructions({
      kind: "campaigns",
      brand: "aurora",
      seedId: "s1",
      campaignIds: ["c1", "c2"],
    });
    expect(text).toContain("`campaigns.md`");
    expect(text).toContain("home/brands/aurora/");
    expect(text).toContain("`c1`, `c2`");
    expect(text).toContain('seedKey: "blog-manager/campaign-seeds/s1"');
    expect(text).toContain('status: "draft"');
    expect(text).toContain("no `goal`");
    expect(text).toContain("mcp__studio__BLOG_STATE_SET");
  });
});

describe("blogCampaignsPrompt", () => {
  test("asks for at most the count, then quotes the seed", () => {
    const text = blogCampaignsPrompt(
      {
        name: "Back to school",
        keywords: ["backpacks", "lunch boxes"],
        prompt: "The school year starts in February.",
      },
      2,
    );
    expect(text).toContain("at most 2 campaign(s)");
    expect(text).toContain("Name: Back to school");
    expect(text).toContain("Terms to aim at: backpacks, lunch boxes");
    expect(text.endsWith("The school year starts in February.")).toBe(true);
  });

  test("a seed with no name or terms is only its words", () => {
    const text = blogCampaignsPrompt(
      { name: "", keywords: [], prompt: "Clear the winter stock." },
      1,
    );
    expect(text).not.toContain("Name:");
    expect(text).not.toContain("Terms to aim at:");
  });
});
