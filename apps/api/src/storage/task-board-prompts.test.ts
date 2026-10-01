import { describe, expect, it } from "bun:test";
import { composeBoardPrompt } from "./task-board-prompts";

describe("composeBoardPrompt", () => {
  it("is undefined when no scope carries anything", () => {
    expect(composeBoardPrompt([])).toBeUndefined();
    expect(composeBoardPrompt([{ prompt: "  ", skills: [] }])).toBeUndefined();
  });

  it("joins prompts in scope order and names each skill once", () => {
    const out = composeBoardPrompt([
      { prompt: "Use pnpm.", skills: ["home/pr", "core/pdf"] },
      { prompt: "", skills: ["home/pr", "home/tests"] },
    ]);
    expect(out).toBe(
      "Use pnpm.\n\nSkills configured for this work — load each one with the skill tool before you start: home/pr, core/pdf, home/tests",
    );
  });
});
