import { describe, expect, it } from "bun:test";
import {
  disabledSelection,
  enabledSelection,
  isSelectionEnabled,
} from "./selection-utils";

describe("isSelectionEnabled", () => {
  it("treats all-null (everything exposed) as enabled", () => {
    expect(
      isSelectionEnabled({
        selected_tools: null,
        selected_resources: null,
        selected_prompts: null,
      }),
    ).toBe(true);
  });

  it("treats all-empty-arrays (nothing exposed) as disabled", () => {
    expect(
      isSelectionEnabled({
        selected_tools: [],
        selected_resources: [],
        selected_prompts: [],
      }),
    ).toBe(false);
  });

  it("treats a legacy subset selection as enabled", () => {
    expect(
      isSelectionEnabled({
        selected_tools: ["a"],
        selected_resources: [],
        selected_prompts: [],
      }),
    ).toBe(true);
  });

  it("treats a resources-only entry (tools [], resources null) as enabled", () => {
    expect(
      isSelectionEnabled({
        selected_tools: [],
        selected_resources: null,
        selected_prompts: [],
      }),
    ).toBe(true);
  });

  it("treats missing resources/prompts as enabled even when tools is empty", () => {
    expect(isSelectionEnabled({ selected_tools: [] })).toBe(true);
  });
});

describe("enabledSelection / disabledSelection", () => {
  it("enabledSelection exposes everything (all null)", () => {
    expect(enabledSelection()).toEqual({
      selected_tools: null,
      selected_resources: null,
      selected_prompts: null,
    });
  });

  it("disabledSelection exposes nothing (all empty arrays)", () => {
    expect(disabledSelection()).toEqual({
      selected_tools: [],
      selected_resources: [],
      selected_prompts: [],
    });
  });

  it("round-trips through isSelectionEnabled", () => {
    expect(isSelectionEnabled(enabledSelection())).toBe(true);
    expect(isSelectionEnabled(disabledSelection())).toBe(false);
  });
});
