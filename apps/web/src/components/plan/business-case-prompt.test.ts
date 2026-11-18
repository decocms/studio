import { describe, expect, it } from "bun:test";
import { en } from "@/i18n/en/index.ts";
import { interpolate } from "@/i18n/interpolate.ts";
import type { TFunction } from "@/i18n/use-t.ts";
import { businessCasePrompt } from "./business-case-prompt.ts";

const t: TFunction = (key, vars) => interpolate(en[key], vars);

const casePath = "/app/org/home/plans/cases/thread-1.json";

describe("businessCasePrompt", () => {
  it("sends the trimmed request, the goal, the case file and the skill path", () => {
    const text = businessCasePrompt(t, {
      idea: "  I want to improve search.  ",
      objective: " Sell more on mobile. ",
      casePath,
    });
    expect(text).toContain("Request: I want to improve search.");
    expect(text).toContain("Store goal: Sell more on mobile.");
    expect(text).toContain(`The canvas for this case is ${casePath}`);
    expect(text).toContain("/app/org/public/core/business-case/SKILL.md");
  });

  it("leaves the goal line out when there is no goal", () => {
    for (const objective of [null, undefined, "   "]) {
      const text = businessCasePrompt(t, { idea: "Idea", objective, casePath });
      expect(text).not.toContain("Store goal");
      expect(text).toContain("Request: Idea");
      expect(text).toContain(casePath);
    }
  });
});
