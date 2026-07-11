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
