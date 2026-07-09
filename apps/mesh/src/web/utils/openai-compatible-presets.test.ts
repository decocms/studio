import { describe, expect, it } from "bun:test";
import {
  getPreset,
  OPENAI_COMPATIBLE_PRESETS,
} from "./openai-compatible-presets";

describe("getPreset", () => {
  it("returns the matching preset by id", () => {
    expect(getPreset("ollama")?.name).toBe("Ollama");
  });

  it("returns undefined for an unknown id", () => {
    expect(getPreset("not-a-real-preset")).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(getPreset(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(getPreset(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(getPreset("")).toBeUndefined();
  });

  it("is case-sensitive", () => {
    expect(getPreset("Ollama")).toBeUndefined();
  });

  it("resolves every declared preset id", () => {
    for (const preset of OPENAI_COMPATIBLE_PRESETS) {
      expect(getPreset(preset.id)).toBe(preset);
    }
  });
});
