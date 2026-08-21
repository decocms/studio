import { describe, expect, it } from "bun:test";
import { Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { isMaxStepRetriesError, MAX_STEP_RETRIES_CODE } from "./step-errors";

describe("isMaxStepRetriesError", () => {
  it("matches the code the SDK stamps on an exhausted step", () => {
    const err = new DBOSErrors.DBOSMaxStepRetriesError("attachImage", 3, [
      new Error("502"),
    ]);
    expect(DBOSErrors.getDBOSErrorCode(err)).toBe(MAX_STEP_RETRIES_CODE);
    expect(isMaxStepRetriesError(err)).toBe(true);
  });

  it("matches a revived error, where the class and the name are both gone", () => {
    const original = new DBOSErrors.DBOSMaxStepRetriesError("step", 1, []);
    expect(original.name).toBe("Error");
    const revived = Object.assign(new Error(original.message), {
      dbosErrorCode: MAX_STEP_RETRIES_CODE,
    });
    expect(revived instanceof DBOSErrors.DBOSMaxStepRetriesError).toBe(false);
    expect(isMaxStepRetriesError(revived)).toBe(true);
  });

  it("does not match the errors a workflow must not swallow", () => {
    expect(
      isMaxStepRetriesError(new DBOSErrors.DBOSWorkflowCancelledError("wf-1")),
    ).toBe(false);
    expect(
      isMaxStepRetriesError(
        new DBOSErrors.DBOSUnexpectedStepError("wf-1", 1, "a", "b"),
      ),
    ).toBe(false);
    expect(isMaxStepRetriesError(new Error("plain"))).toBe(false);
    expect(isMaxStepRetriesError("not an error")).toBe(false);
  });
});
