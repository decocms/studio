import { describe, expect, test } from "bun:test";
import { shouldSkipStudioContext, SYSTEM_PATHS } from "./paths";

describe("DBOS queue-depth path", () => {
  test("skips StudioContext for the queue-depth endpoint", () => {
    expect(
      shouldSkipStudioContext(
        `${SYSTEM_PATHS.DBOS_QUEUE_DEPTH_PREFIX}automations`,
      ),
    ).toBe(true);
  });

  test("does not match unrelated paths", () => {
    expect(shouldSkipStudioContext("/api/dbos-queue-depth/automations")).toBe(
      false,
    );
    expect(shouldSkipStudioContext("/dbos-queue-depth")).toBe(false);
  });
});

describe("hosted-run-pending path", () => {
  test("skips StudioContext for the hosted-run-pending endpoint", () => {
    expect(shouldSkipStudioContext(SYSTEM_PATHS.HOSTED_RUN_PENDING)).toBe(true);
  });

  test("does not match the API-prefixed variant", () => {
    expect(shouldSkipStudioContext("/api/hosted-run-pending")).toBe(false);
  });
});
