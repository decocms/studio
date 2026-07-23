import { composeSandboxRef, sharedSandboxId } from "@decocms/sandbox/provider";
import type { StudioContext } from "../../core/studio-context";
import type { AgentSandboxSession } from "../../storage/agent-sandbox-sessions";
import { getSharedAgentSandboxProvider } from "../../sandbox/lifecycle";
import { computeClaimHandle } from "../../sandbox/claim-handle";

const DELETE_CONCURRENCY = 20;

export async function deleteAgentSandboxSessions(
  ctx: StudioContext,
  sessions: AgentSandboxSession[],
): Promise<void> {
  if (sessions.length === 0) return;

  const runner = await getSharedAgentSandboxProvider(ctx);
  for (let offset = 0; offset < sessions.length; offset += DELETE_CONCURRENCY) {
    const batch = sessions.slice(offset, offset + DELETE_CONCURRENCY);
    await Promise.all(
      batch.map(async (session) => {
        const projectRef = composeSandboxRef({
          orgId: session.organizationId,
          virtualMcpId: session.virtualMcpId,
          branch: session.branch,
        });
        const sandboxId = sharedSandboxId(projectRef);
        const locator = {
          organizationId: session.organizationId,
          virtualMcpId: session.virtualMcpId,
          branch: session.branch,
        };
        const current = await ctx.storage.agentSandboxSessions.withLock(
          locator,
          (storage) => storage.beginDelete(locator, session.lastStartedBy),
        );
        if (!current) return;
        await runner.delete(
          current.sandboxHandle ??
            computeClaimHandle(sandboxId, session.branch),
          sandboxId,
        );
        await ctx.storage.agentSandboxSessions.withLock(locator, (storage) =>
          storage.completeDelete(locator, current.generation),
        );
      }),
    );
  }
}

export async function deleteAllAgentSandboxSessionsForVirtualMcp(
  ctx: StudioContext,
  organizationId: string,
  virtualMcpId: string,
): Promise<void> {
  while (true) {
    const sessions = await ctx.storage.agentSandboxSessions.listByVirtualMcp(
      organizationId,
      virtualMcpId,
      { limit: 200 },
    );
    if (sessions.length === 0) return;
    await deleteAgentSandboxSessions(ctx, sessions);
  }
}
