import { DBOS } from "@dbos-inc/dbos-sdk";
import { getDb } from "@/database";
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
 * Backfill `selected_prompts` on previously-installed studio-pack agents.
 * Pre-prompt-whitelist installs wrote `null` (all prompts allowed); we
 * narrow each agent to its own checklist prompts (or `[]` for agents with
 * no onboarding items).
 */
async function backfillSelectedPromptsStep(
  input: InstallStudioPackInput,
): Promise<void> {
  const database = getDb();
  const virtualMcpStorage = new VirtualMCPStorage(database.db);

  for (const agent of STUDIO_PACK_AGENTS) {
    const agentId = agent.getId(input.orgId);
    const existing = await virtualMcpStorage.findById(agentId, input.orgId);
    if (!existing) continue;

    // Empty array means "no prompts"; null means "all prompts allowed".
    // We always want the explicit array post-whitelist.
    const desired = agent.selectedPrompts ? [...agent.selectedPrompts] : null;

    const sameAsDesired = existing.connections.every((c) => {
      const current = c.selected_prompts;
      if (desired === null) return current === null;
      if (current === null) return false;
      if (current.length !== desired.length) return false;
      return current.every((p, i) => p === desired[i]);
    });
    if (sameAsDesired) continue;

    await virtualMcpStorage.update(agentId, input.createdBy, {
      connections: existing.connections.map((c) => ({
        connection_id: c.connection_id,
        selected_tools: c.selected_tools,
        selected_resources: c.selected_resources,
        selected_prompts: desired,
      })),
    });
  }
}

async function installStudioPackWorkflowFn(
  input: InstallStudioPackInput,
): Promise<void> {
  await DBOS.runStep(() => installStudioPackStep(input), {
    name: "installStudioPack",
  });
  await DBOS.runStep(() => backfillSelectedPromptsStep(input), {
    name: "backfillSelectedPrompts",
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
