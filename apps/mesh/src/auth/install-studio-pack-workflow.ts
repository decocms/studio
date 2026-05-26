import { DBOS } from "@dbos-inc/dbos-sdk";
import { getDb } from "@/database";
import { SqlThreadStorage } from "@/storage/threads";
import { VirtualMCPStorage } from "@/storage/virtual";
import {
  STUDIO_PACK_AGENTS,
  installStudioPack,
} from "@/tools/virtual/studio-pack";

export interface InstallStudioPackInput {
  orgId: string;
  createdBy: string;
}

async function installStudioPackStep(
  input: InstallStudioPackInput,
): Promise<void> {
  const database = getDb();
  const virtualMcpStorage = new VirtualMCPStorage(database.db);
  await installStudioPack(input.orgId, input.createdBy, virtualMcpStorage);
}

/**
 * Create empty thread rows for each Studio Pack agent so the Tasks-panel
 * checklist can navigate to a stable `thrd_welcome_<agentId>` URL. We
 * intentionally do NOT persist a greeting message — welcomes are
 * state-dependent (Agent Manager / Brand Manager / Automation Manager
 * pivot copy based on org state) and a once-rendered snapshot drifts
 * from reality the moment the user creates an agent or sets brand
 * context. The chat renders the welcome from current state when the
 * thread is opened with no real messages.
 */
async function createWelcomeThreadsStep(
  input: InstallStudioPackInput,
): Promise<void> {
  const database = getDb();
  const threads = new SqlThreadStorage(database.db);

  for (const agent of STUDIO_PACK_AGENTS) {
    const agentId = agent.getId(input.orgId);
    const threadId = `thrd_welcome_${agentId}`;

    await threads.create({
      id: threadId,
      organization_id: input.orgId,
      title: agent.title,
      status: "completed",
      virtual_mcp_id: agentId,
      created_by: input.createdBy,
    });
  }
}

async function installStudioPackWorkflowFn(
  input: InstallStudioPackInput,
): Promise<void> {
  await DBOS.runStep(() => installStudioPackStep(input), {
    name: "installStudioPack",
  });
  await DBOS.runStep(() => createWelcomeThreadsStep(input), {
    name: "createWelcomeThreads",
  });
}

const installStudioPackWorkflow = DBOS.registerWorkflow(
  installStudioPackWorkflowFn,
  { name: "installStudioPackWorkflow" },
);

/**
 * Fire-and-forget enqueue from the Better Auth org.afterCreate callback.
 * Workflow ID is deterministic per org so an accidental double-fire
 * collapses onto the same workflow via OAOO.
 */
export async function enqueueInstallStudioPack(
  input: InstallStudioPackInput,
): Promise<void> {
  await DBOS.startWorkflow(installStudioPackWorkflow, {
    workflowID: `install-studio-pack:${input.orgId}`,
  })(input);
}

export async function backfillStudioPackForAllOrgs(): Promise<void> {
  const database = getDb();
  const rows = await database.db
    .selectFrom("member")
    .select(["organizationId", "userId"])
    .orderBy("createdAt", "asc")
    .execute();

  const orgToUser = new Map<string, string>();
  for (const r of rows) {
    if (!orgToUser.has(r.organizationId)) {
      orgToUser.set(r.organizationId, r.userId);
    }
  }

  await Promise.all(
    Array.from(orgToUser).map(async ([orgId, createdBy]) => {
      try {
        await enqueueInstallStudioPack({ orgId, createdBy });
      } catch (err) {
        console.error("[studio-pack-backfill] enqueue failed", { orgId }, err);
      }
    }),
  );
}
