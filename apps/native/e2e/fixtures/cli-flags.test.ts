import { describe, expect, test } from "bun:test";
import { cliFlagValues, hasCliFlag } from "./cli-flags.mjs";

describe("terminal fixture CLI flags", () => {
  test("matches split and inline values without hiding duplicates", () => {
    const args = [
      "--agent",
      "studio-native-a",
      "--session=ses_123",
      "--model=gpt-5",
      "--model",
      "claude",
      "--session",
    ];

    expect(cliFlagValues(args, "--agent")).toEqual(["studio-native-a"]);
    expect(cliFlagValues(args, "--session")).toEqual(["ses_123", undefined]);
    expect(cliFlagValues(args, "--model")).toEqual(["gpt-5", "claude"]);
    expect(hasCliFlag(args, "--model")).toBeTrue();
    expect(hasCliFlag(args, "--unknown")).toBeFalse();
  });
});
