import { describe, expect, test } from "bun:test";
import { shouldBlockHostedRuntime } from "./hosted-runtime-guard";

describe("hosted runtime guard", () => {
  test("blocks a hosted row explicitly disabled during migration", () => {
    expect(
      shouldBlockHostedRuntime({
        isDesktopApp: false,
        hostedExecutionDisabledAt: "2026-08-04T00:00:00.000Z",
      }),
    ).toBeTrue();
  });

  test("leaves the native runtime available for a disabled hosted row", () => {
    expect(
      shouldBlockHostedRuntime({
        isDesktopApp: true,
        hostedExecutionDisabledAt: "2026-08-04T00:00:00.000Z",
      }),
    ).toBeFalse();
  });

  test("allows hosted rows without the explicit tombstone", () => {
    for (const hostedExecutionDisabledAt of [null, undefined]) {
      expect(
        shouldBlockHostedRuntime({
          isDesktopApp: false,
          hostedExecutionDisabledAt,
        }),
      ).toBeFalse();
    }
  });
});
