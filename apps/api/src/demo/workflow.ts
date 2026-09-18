import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import type { Database } from "@/storage/types";
import { DemoStorage } from "@/storage/demo";
import { emitDemoUpdated } from "./events";

let storage: DemoStorage | undefined;
let runWorkflow: typeof execute | undefined;

async function execute(orgId: string, runId: string) {
  for (let step = 0; step < 3; step++) {
    if (step > 0) await DBOS.sleep(1800);
    const run = await DBOS.runStep(
      async () => {
        if (!storage) throw new Error("Demo runtime is not initialized");
        const result = await storage.advance(orgId, runId, step);
        if (result)
          emitDemoUpdated(orgId, {
            id: result.thread_id,
            step: result.step,
            completed: result.state !== "pending",
          });
        return result;
      },
      { name: `demoStage:${step}`, retriesAllowed: true, maxAttempts: 3 },
    );
    if (!run || run.state !== "pending") return;
  }
}

/** Durable outbox safety net if admission committed just before a process stopped. */
async function resumePending(_scheduled: Date, _now: Date) {
  const pending = await DBOS.runStep(
    () => {
      if (!storage) throw new Error("Demo runtime is not initialized");
      return storage.pending();
    },
    { name: "pendingDemoRuns" },
  );
  for (const run of pending) {
    const status = await DBOS.getWorkflowStatus(run.id);
    if (status?.status === "ERROR" || status?.status === "CANCELLED") {
      await DBOS.runStep(
        async () => {
          await storage!.fail(run.organization_id, run.id);
          emitDemoUpdated(run.organization_id);
        },
        { name: `failDemoRun:${run.id}` },
      );
    } else if (status?.status === "MAX_RECOVERY_ATTEMPTS_EXCEEDED") {
      await DBOS.resumeWorkflow(run.id);
    } else await startDemoRun(run.organization_id, run.id);
  }
}

export async function startDemoRun(orgId: string, runId: string) {
  if (!runWorkflow) throw new Error("Demo runtime is not initialized");
  await DBOS.startWorkflow(runWorkflow, { workflowID: runId })(orgId, runId);
}

export function registerDemoWorkflows(db: Kysely<Database>) {
  storage = new DemoStorage(db);
  if (runWorkflow) return;
  runWorkflow = DBOS.registerWorkflow(execute, { name: "demoScenarioV1" });
  const recover = DBOS.registerWorkflow(resumePending, {
    name: "demoResumePendingV1",
  });
  DBOS.registerScheduled(recover, {
    name: "demoResumePendingV1",
    crontab: "* * * * *",
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
