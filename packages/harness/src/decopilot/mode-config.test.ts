import { describe, expect, it } from "bun:test";
import { resolveModeConfig } from "./mode-config";

describe("resolveModeConfig", () => {
  it("default mode forces nothing and injects no prompts", () => {
    const config = resolveModeConfig("default", { isCliAgent: false });
    expect(config).toEqual({
      isPlanMode: false,
      forcedFirstStepTool: null,
      planPrompt: null,
      webSearchInstructionPrompt: null,
    });
  });

  it("plan mode sets isPlanMode and builds a planPrompt, no tool forcing", () => {
    const config = resolveModeConfig("plan", { isCliAgent: false });
    expect(config.isPlanMode).toBe(true);
    expect(config.forcedFirstStepTool).toBeNull();
    expect(config.webSearchInstructionPrompt).toBeNull();
    expect(config.planPrompt).toContain("propose_plan");
  });

  it("plan mode drops the propose_plan requirement for CLI agents", () => {
    const config = resolveModeConfig("plan", { isCliAgent: true });
    expect(config.planPrompt).not.toContain("propose_plan");
    expect(config.planPrompt).toContain("plan mode");
  });

  it("web-search mode forces web_search and injects the search instruction prompt", () => {
    const config = resolveModeConfig("web-search", { isCliAgent: false });
    expect(config.isPlanMode).toBe(false);
    expect(config.forcedFirstStepTool).toBe("web_search");
    expect(config.planPrompt).toBeNull();
    expect(config.webSearchInstructionPrompt).toContain("web_search");
  });

  it("deep-research mode forces deep_research and shares the search instruction prompt", () => {
    const config = resolveModeConfig("deep-research", { isCliAgent: false });
    expect(config.forcedFirstStepTool).toBe("deep_research");
    expect(config.webSearchInstructionPrompt).toContain("deep_research");
  });

  it("gen-image mode forces generate_image with no instruction prompt", () => {
    const config = resolveModeConfig("gen-image", { isCliAgent: false });
    expect(config.forcedFirstStepTool).toBe("generate_image");
    expect(config.webSearchInstructionPrompt).toBeNull();
    expect(config.planPrompt).toBeNull();
  });
});
