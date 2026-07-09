import { describe, expect, it } from "bun:test";
import { DBOS_WORKFLOW_VERSION } from "./workflow-version";

describe("DBOS_WORKFLOW_VERSION", () => {
  it("is a stable non-empty string", () => {
    expect(typeof DBOS_WORKFLOW_VERSION).toBe("string");
    expect(DBOS_WORKFLOW_VERSION.length).toBeGreaterThan(0);
  });

  it("is the current pinned version", () => {
    expect(DBOS_WORKFLOW_VERSION).toBe("4");
  });
});
