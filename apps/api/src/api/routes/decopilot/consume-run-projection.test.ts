import { describe, expect, it } from "bun:test";
import { consumeRunProjection } from "./consume-run-projection";
import {
  type ProjectorRunRow,
  type ProjectorWorkflowRuntime,
  setProjectorWorkflowRuntime,
} from "./projector-workflow";

/**
 * Minimal runtime stub. The entry-guard tests only reach `resolveRun` and
 * `getJetStream` — every other method stays unreached, so we cast a tiny object
 * rather than stub the whole runtime. `getJetStream` returns null on purpose:
 * when the guard lets the run through, consume hits the JetStream lookup and
 * throws "JetStream unavailable" — that throw is our "it proceeded" signal.
 */
function installRuntime(row: ProjectorRunRow | null): void {
  setProjectorWorkflowRuntime({
    resolveRun: async () => row,
    getJetStream: () => null,
  } as unknown as ProjectorWorkflowRuntime);
}

function runRow(over: Partial<ProjectorRunRow>): ProjectorRunRow {
  return {
    orgId: "org_1",
    createdBy: "user_1",
    version: 2,
    status: "in_progress",
    runFenceToken: "fence-A",
    title: null,
    ...over,
  };
}

describe("consumeRunProjection entry guard", () => {
  it("PROCEEDS when the row is terminal but the fence still matches (same-fence early-terminal must not skip)", async () => {
    // runId === threadId, so the thread's status is shared across turns. A
    // hosted onFinish (or a prior turn) can leave the thread terminal while
    // THIS fence's {done} is still unprojected. Skipping on terminal status
    // would strand the turn ("No response was generated") and leak the done
    // sentinel. The guard must gate on the live fence, not the status.
    installRuntime(runRow({ status: "completed", runFenceToken: "fence-A" }));
    await expect(
      consumeRunProjection({ runId: "thrd_1", fenceToken: "fence-A" }),
    ).rejects.toThrow("JetStream unavailable");
  });

  it("SKIPS when a newer fence owns the row (stale older attempt), even while in_progress", async () => {
    // A different live fence means this projector event belongs to an older
    // run attempt; it must not materialize over the newer attempt — regardless
    // of the (non-terminal) status.
    installRuntime(runRow({ status: "in_progress", runFenceToken: "fence-B" }));
    await expect(
      consumeRunProjection({ runId: "thrd_1", fenceToken: "fence-A" }),
    ).resolves.toBeUndefined();
  });

  it("PROCEEDS for a fresh same-fence run (in_progress)", async () => {
    installRuntime(runRow({ status: "in_progress", runFenceToken: "fence-A" }));
    await expect(
      consumeRunProjection({ runId: "thrd_1", fenceToken: "fence-A" }),
    ).rejects.toThrow("JetStream unavailable");
  });
});
