/**
 * Shared helper for configuring triggers on MCP connections.
 *
 * Calls TRIGGER_CONFIGURE on the target connection to enable/disable
 * an event trigger. Returns success/error status without throwing.
 */

import type { MeshContext } from "@/core/mesh-context";
import type { AutomationTrigger } from "@/storage/types";
import { TriggerBinding } from "@decocms/bindings/trigger";
import type { MCPConnection } from "@decocms/bindings/connection";

export async function configureTriggerOnMcp(
  ctx: MeshContext,
  trigger: AutomationTrigger,
  enabled: boolean,
): Promise<{ success: boolean; error?: string }> {
  if (trigger.type !== "event" || !trigger.connection_id)
    return { success: true };

  const connection = await ctx.storage.connections.findById(
    trigger.connection_id,
  );
  if (!connection) return { success: true }; // Connection may have been deleted

  try {
    const client = TriggerBinding.forConnection(
      connection as unknown as MCPConnection,
    );
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("TRIGGER_CONFIGURE timeout")), 5000),
    );
    await Promise.race([
      client.TRIGGER_CONFIGURE({
        type: trigger.event_type!,
        params: JSON.parse(trigger.params ?? "{}"),
        enabled,
      }),
      timeoutPromise,
    ]);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
