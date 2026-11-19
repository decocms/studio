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

  it("adds no guided section when the intro did not run", () => {
    const text = businessCasePrompt(t, {
      idea: "Idea",
      objective: null,
      casePath,
    });
    expect(text).not.toContain("Before this chat");
    expect(text).toContain("ask me one thing at a time");
  });

  it("lists the guided answers, marking skipped ones, so the agent does not ask again", () => {
    const text = businessCasePrompt(t, {
      idea: "Improve search",
      objective: null,
      casePath,
      answers: [
        { question: "What bothers you most?", answer: " Empty results " },
        { question: "Which device?", answer: "  " },
      ],
    });
    expect(text).toContain("Do not ask them again");
    expect(text).toContain("- What bothers you most?\n  Empty results");
    expect(text).toContain(
      "- Which device?\n  (skipped: assume it and write the assumption on the card)",
    );
  });

  it("tells the agent nothing was missing when the intro asked nothing", () => {
    const text = businessCasePrompt(t, {
      idea: "A fit guide on the mobile PDP",
      objective: null,
      casePath,
      answers: [],
    });
    expect(text).toContain("nothing was");
    expect(text).not.toContain("Do not ask them again");
  });
});
