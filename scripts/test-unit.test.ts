import { describe, expect, test } from "bun:test";
import { buildUnitTestCommand } from "./test-unit";

describe("buildUnitTestCommand", () => {
  test("keeps the complete unit-test file list without a timings profile", () => {
    expect(buildUnitTestCommand(["a.test.ts", "b.test.ts"])).toEqual([
      "bun",
      "test",
      "--parallel",
      "a.test.ts",
      "b.test.ts",
    ]);
  });

  test("reads and refreshes the configured timings profile", () => {
    expect(
      buildUnitTestCommand(
        ["a.test.ts", "b.test.ts"],
        "/tmp/unit test timings.json",
      ),
    ).toEqual([
      "bun",
      "test",
      "--parallel",
      "--timings=/tmp/unit test timings.json",
      "--update-timings",
      "a.test.ts",
      "b.test.ts",
    ]);
  });
});
