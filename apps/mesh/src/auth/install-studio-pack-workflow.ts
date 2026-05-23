import { DBOS } from "@dbos-inc/dbos-sdk";
import { isStudioPackAgent } from "@decocms/mesh-sdk";
import { getDb } from "@/database";
import { BrandContextStorage } from "@/storage/brand-context";
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

async function createWelcomeThreadsStep(
  input: InstallStudioPackInput,
): Promise<void> {
  const database = getDb();
  const threads = new SqlThreadStorage(database.db);
  const brandContexts = new BrandContextStorage(database.db);
  const virtualMcps = new VirtualMCPStorage(database.db);
  const now = new Date().toISOString();

  const existingBrands = await brandContexts.list(input.orgId);
  const hasBrandContext = existingBrands.length > 0;
  const allVirtualMcps = await virtualMcps.list(input.orgId);
  const hasCustomAgents = allVirtualMcps.some(
    (vm) => !isStudioPackAgent(vm.id),
  );

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

    const parts = await agent.welcomeMessage({
      orgId: input.orgId,
      createdBy: input.createdBy,
      hasBrandContext,
      hasCustomAgents,
    });

    await threads.saveMessages(
      [
        {
          id: `${threadId}-msg-welcome`,
          thread_id: threadId,
          role: "assistant",
          parts,
          metadata: undefined,
          created_at: now,
          updated_at: now,
        },
      ],
      input.orgId,
    );
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
