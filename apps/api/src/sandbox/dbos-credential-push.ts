/**
 * Every 10 minutes, one pod pushes fresh sandbox credentials to the control
 * plane (see `credential-push.ts`). Pushed clone tokens live at least 45
 * minutes, so the host always holds one with 30+ minutes left, which is what
 * its own periodic re-mint asks for. No-ops unless Studio runs sandboxes on a
 * control plane.
 *
 * One step for the whole tick: its I/O is recorded in the DBOS system
 * database, so it returns counts, never the credentials it minted.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import { getDb } from "@/database";
import { CredentialVault } from "@/encryption/credential-vault";
import { sandboxCredentialMinters } from "@/sandbox/credential-mint";
import {
  credentialRecords,
  mintCredentialPush,
  ORG_FS_CONFIG_LIFETIME_MS,
  planCredentialPush,
} from "@/sandbox/credential-push";
import { parseLegacyTenantPools } from "@/sandbox/legacy-tenant-pools";
import {
  getOrInitSharedRunner,
  readControlPlaneSandboxConfig,
} from "@/sandbox/lifecycle";
import { getSettings } from "@/settings";

/** Minutes 1, 11, 21…: off the other 10-minute sweeps' ticks. */
const CREDENTIAL_PUSH_CRONTAB = "1-59/10 * * * *";

interface PushOutcome {
  sandboxes: number;
  pushed: number;
  kept: number;
  refused: number;
  failed: number;
}

/** Never throws: a host that is down now gets the next tick's push. */
async function pushSandboxCredentialsOnce(): Promise<PushOutcome | null> {
  try {
    return await pushSandboxCredentials();
  } catch (err) {
    console.warn(
      `[sandbox-credential-push] push failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function pushSandboxCredentials(): Promise<PushOutcome | null> {
  if (!readControlPlaneSandboxConfig()) return null;
  const [{ RemoteSandboxProvider }, { SandboxProviderRouter }] =
    await Promise.all([
      import("@decocms/sandbox/provider/remote"),
      import("@decocms/sandbox/provider/router"),
    ]);
  const shared = await getOrInitSharedRunner();
  const runner =
    shared instanceof SandboxProviderRouter
      ? shared.providers.kubernetes
      : shared;
  if (!(runner instanceof RemoteSandboxProvider)) return null;

  const { db } = getDb();
  const { sandboxes, pools } = await runner.list();
  const now = Date.now();
  const plan = planCredentialPush({
    sandboxes,
    pools,
    records: await credentialRecords(db, sandboxes, pools),
    legacyPools: parseLegacyTenantPools(
      process.env.STUDIO_SANDBOX_TENANT_POOLS,
    ),
    now,
  });
  const { batches, failed } = await mintCredentialPush(
    plan,
    sandboxCredentialMinters(
      db,
      new CredentialVault(getSettings().encryptionKey),
    ),
    { now, orgFsLifetimeMs: ORG_FS_CONFIG_LIFETIME_MS },
  );
  let pushed = 0;
  let kept = 0;
  for (const batch of batches) {
    const result = await runner.pushCredentials(batch);
    pushed += result.stored;
    kept += result.kept;
  }
  return {
    sandboxes: sandboxes.length,
    pushed,
    kept,
    refused: plan.refused,
    failed,
  };
}

async function sandboxCredentialPushWorkflowFn(
  _scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  const outcome = await DBOS.runStep(pushSandboxCredentialsOnce, {
    name: "pushSandboxCredentials",
  });
  if (outcome && (outcome.refused > 0 || outcome.failed > 0)) {
    console.warn(
      `[sandbox-credential-push] ${outcome.sandboxes} sandboxes: pushed ${outcome.pushed}, kept ${outcome.kept}, refused ${outcome.refused}, failed ${outcome.failed}`,
    );
  }
}

let registeredWorkflow: typeof sandboxCredentialPushWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerSandboxCredentialPushWorkflow(): void {
  if (registeredWorkflow) return;
  // Unscheduled unless sandboxes run on the control plane, so a deploy
  // without it changes nothing.
  if (!getSettings().agentSandboxEnabled || !readControlPlaneSandboxConfig()) {
    return;
  }
  registeredWorkflow = DBOS.registerWorkflow(sandboxCredentialPushWorkflowFn, {
    name: "sandboxCredentialPushWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "sandboxCredentialPushWorkflow",
    crontab: CREDENTIAL_PUSH_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
