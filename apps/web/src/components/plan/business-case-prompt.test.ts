import { describe, expect, it } from "bun:test";
import { en } from "@/i18n/en/index.ts";
import { interpolate } from "@/i18n/interpolate.ts";
import type { TFunction } from "@/i18n/use-t.ts";
import { businessCasePrompt } from "./business-case-prompt.ts";

const t: TFunction = (key, vars) => interpolate(en[key], vars);

describe("businessCasePrompt", () => {
  it("sends the trimmed idea, the goal and the skill path", () => {
    const text = businessCasePrompt(t, {
      idea: "  Show shipping in the cart.  ",
      objective: " Sell more on mobile. ",
    });
    expect(text).toContain("Idea: Show shipping in the cart.");
    expect(text).toContain("Store goal: Sell more on mobile.");
    expect(text).toContain("/app/org/public/core/business-case/SKILL.md");
  });

  it("leaves the goal line out when there is no goal", () => {
    for (const objective of [null, undefined, "   "]) {
      const text = businessCasePrompt(t, { idea: "Idea", objective });
      expect(text).not.toContain("Store goal");
      expect(text).toContain("Idea: Idea");
    }
  });
});
