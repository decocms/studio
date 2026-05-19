import type { MeshContext } from "@/core/mesh-context";
import type { SSEEvent } from "@/event-bus";
import { createDecopilotThreadStatusEvent } from "@decocms/mesh-sdk";

export interface BuildOnTitleUpdatedDeps {
  ctx: MeshContext;
  sseHub: { emit(orgId: string, event: SSEEvent): void };
  threadId: string;
  organizationId: string;
}

/**
 * Build the `onTitleUpdated` callback invoked by the harness after the
 * auto-titler commits a generated title to the DB. The callback emits a
 * `decopilot.thread.status` event on the SSE hub so other tabs/sessions
 * (not subscribed to this thread's /stream) see the new title. Best-effort:
 * a failed row load still emits an event with at least the title field.
 */
export function buildOnTitleUpdated(
  deps: BuildOnTitleUpdatedDeps,
): (title: string) => Promise<void> {
  return async (title) => {
    let row: Awaited<ReturnType<typeof deps.ctx.storage.threads.get>> | null =
      null;
    try {
      row = await deps.ctx.storage.threads.get(deps.threadId);
    } catch {
      row = null;
    }
    deps.sseHub.emit(
      deps.organizationId,
      createDecopilotThreadStatusEvent(deps.threadId, "in_progress", {
        title,
        virtualMcpId: row?.virtual_mcp_id ?? undefined,
        createdBy: row?.created_by,
        triggerId: row?.trigger_id,
        branch: row?.branch ?? null,
        createdAt: row?.created_at,
        updatedAt: row?.updated_at,
      }),
    );
  };
}
