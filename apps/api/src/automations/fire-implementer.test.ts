/**
 * `manualFireError` is what keeps a manual fire from reporting success on a
 * no-op — see `rerun.ts`'s "a swallowed failure here is exactly the silent
 * no-op this tool exists to remove".
 */

import { describe, expect, it } from "bun:test";
import { TaskQuotaError } from "@/billing/task-quota";
import { manualFireError } from "./fire-implementer";

describe("manualFireError", () => {
  it("is null once a run started", () => {
    expect(manualFireError({ taskId: "thrd_1" })).toBeNull();
  });

  it("surfaces a quota refusal as a TaskQuotaError", () => {
    const err = manualFireError({
      skipped: "rejected",
      error: { message: "no runs left", quotaReason: "runs_exhausted" },
    });
    expect(err).toBeInstanceOf(TaskQuotaError);
  });

  it("surfaces a plain dispatch failure with its message", () => {
    const err = manualFireError({
      skipped: "rejected",
      error: { message: "no model configured" },
    });
    expect(err?.message).toBe("no model configured");
  });

  it("surfaces a skip with no error instead of reporting success", () => {
    const err = manualFireError({ skipped: "card_gone" });
    expect(err?.message).toBe("The Implementer did not start (card_gone).");
  });

  it("surfaces the string error from a non-card fire", () => {
    const err = manualFireError({ taskId: "thrd_1", error: "no model" });
    expect(err?.message).toBe("no model");
  });
});
