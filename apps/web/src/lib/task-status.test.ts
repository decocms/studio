import { describe, expect, it } from "bun:test";
import { getStatusConfig } from "./task-status";

describe("getStatusConfig", () => {
  it("treats a known status key as itself", () => {
    expect(getStatusConfig("failed").labelKey).toBe("common.taskStatus.failed");
  });

  it("treats an unrecognized status string as unknown", () => {
    expect(getStatusConfig("some_future_status").labelKey).toBe(
      "common.taskStatus.unknown",
    );
  });

  it("treats a null status as unknown, not completed", () => {
    expect(getStatusConfig(null).labelKey).toBe("common.taskStatus.unknown");
  });

  it("treats an undefined status as completed", () => {
    expect(getStatusConfig(undefined).labelKey).toBe(
      "common.taskStatus.completed",
    );
  });
});
