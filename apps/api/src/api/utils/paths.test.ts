import { describe, expect, test } from "bun:test";
import { isServerPath, shouldSkipStudioContext, SYSTEM_PATHS } from "./paths";

describe("report page paths", () => {
  test("routes report pages through Hono for dynamic metadata", () => {
    expect(isServerPath("/report/nike.com")).toBe(true);
  });

  test("does not reserve similarly named organization paths", () => {
    expect(isServerPath("/report-team")).toBe(false);
    expect(isServerPath("/reports/nike.com")).toBe(false);
  });
});

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
