/**
 * Shared helper for configuring triggers on MCP connections.
 *
 * Calls TRIGGER_CONFIGURE on the target connection to enable/disable an
 * event trigger. Each trigger is identified by `trigger.id`, which is
 * passed to the MCP as `subscriptionId` so multiple subscriptions can
 * coexist on the same `(connection, event_type)` without overwriting
 * each other's callback credentials.
 *
 * Persistence and the MCP call are kept in sync with two-phase commits:
 *   - On enable: generate a token pair, call TRIGGER_CONFIGURE, then
 *     persist the hash. On timeout we still persist (the MCP may have
 *     accepted) so future callbacks can authenticate. On a definitive
 *     error we skip persistence.
 *   - On disable: call TRIGGER_CONFIGURE, then delete the token row by
 *     subscription. Sibling subscriptions on the same connection are
 *     untouched.
 */

import type { MeshContext } from "@/core/mesh-context";
import { clientFromConnection } from "@/mcp-clients";
import { toServerClient } from "@/api/routes/proxy";
import type { AutomationTrigger } from "@/storage/types";
import type { TriggerCallbackTokenStorage } from "@/storage/trigger-callback-tokens";
import { TriggerBinding } from "@decocms/bindings/trigger";

export async function configureTriggerOnMcp(
  ctx: MeshContext,
  trigger: AutomationTrigger,
  enabled: boolean,
  tokenStorage?: TriggerCallbackTokenStorage,
): Promise<{ success: boolean; error?: string }> {
  if (trigger.type !== "event" || !trigger.connection_id)
    return { success: true };

  if (!trigger.id) {
    return {
      success: false,
      error: "trigger.id required to configure subscription on MCP",
    };
  }

  const connection = await ctx.storage.connections.findById(
    trigger.connection_id,
  );
  if (!connection) return { success: true }; // Connection may have been deleted

  const organizationId = ctx.organization?.id;
  const subscriptionId = trigger.id;

  try {
    const mcpClient = await clientFromConnection(connection, ctx, true);
    const client = TriggerBinding.forClient(toServerClient(mcpClient));

    // Generate token pair (plaintext + hash) without persisting to DB
    let callbackUrl: string | undefined;
    let callbackToken: string | undefined;
    let tokenHash: string | undefined;
    if (enabled && tokenStorage && organizationId) {
      const pair = await tokenStorage.generateTokenPair();
      callbackToken = pair.plaintext;
      tokenHash = pair.hash;
      callbackUrl = `${ctx.baseUrl}/api/trigger-callback`;
    }

    const TIMEOUT_MS = 5000;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => {
        timedOut = true;
        reject(new Error("TRIGGER_CONFIGURE timeout"));
      }, TIMEOUT_MS),
    );

    try {
      await Promise.race([
        client.TRIGGER_CONFIGURE({
          type: trigger.event_type!,
          params: JSON.parse(trigger.params ?? "{}"),
          enabled,
          callbackUrl,
          callbackToken,
          subscriptionId,
        }),
        timeoutPromise,
      ]);
    } catch (err) {
      if (timedOut && enabled && tokenStorage && organizationId && tokenHash) {
        // Timeout is ambiguous — the MCP may still accept the token.
        // Persist the hash so future callbacks can authenticate.
        await tokenStorage.persistTokenHash({
          organizationId,
          connectionId: trigger.connection_id,
          subscriptionId,
          tokenHash,
        });
      }
      // On definitive (non-timeout) failure, skip persistence —
      // the MCP rejected the call, old token (if any) is still valid.
      return { success: false, error: String(err) };
    }

    // MCP confirmed — persist token or clean up.
    // If DB write fails, log but still return success so the caller
    // creates the trigger record (the MCP is already listening).
    try {
      if (enabled && tokenStorage && organizationId && tokenHash) {
        await tokenStorage.persistTokenHash({
          organizationId,
          connectionId: trigger.connection_id,
          subscriptionId,
          tokenHash,
        });
      }
      if (!enabled && tokenStorage) {
        await tokenStorage.deleteBySubscription(subscriptionId);
      }
    } catch (dbErr) {
      console.error(
        `[configureTriggerOnMcp] Token persistence failed after successful TRIGGER_CONFIGURE:`,
        dbErr,
      );
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
