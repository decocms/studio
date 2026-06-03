/**
 * AUTOMATION_TRIGGER_ROTATE_TOKEN Tool
 *
 * Rotates the Better Auth API key behind a webhook trigger:
 *   1. Create a new key with the same scope (`webhook_<trigger_id>: [FIRE]`).
 *   2. Atomically swap `api_key_id` on the trigger row.
 *   3. Delete the old key (best-effort — if delete fails the new key is
 *      already live, so the trigger keeps working).
 *
 * Both new and old keys are valid for the brief window between step 1 and
 * step 3. This is intentional: it lets a caller deploy the new token to
 * the upstream sender before the old one is revoked.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { webhookPermissionResource, webhookUrl } from "./webhook-trigger";

export const AUTOMATION_TRIGGER_ROTATE_TOKEN = defineTool({
  name: "AUTOMATION_TRIGGER_ROTATE_TOKEN",
  description:
    "Rotate the secret token for a webhook automation trigger. Returns a new token; the old token is revoked.",
  annotations: {
    title: "Rotate Webhook Token",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    trigger_id: z.string(),
  }),
  outputSchema: z.object({
    trigger_id: z.string(),
    url: z.string(),
    token: z.string(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const trigger = await ctx.storage.automations.findTriggerById(
      input.trigger_id,
    );
    if (!trigger) throw new Error("Trigger not found");
    if (trigger.type !== "webhook") {
      throw new Error("Trigger is not a webhook trigger");
    }

    // Verify parent automation belongs to this org.
    const automation = await ctx.storage.automations.findById(
      trigger.automation_id,
      organization.id,
    );
    if (!automation) throw new Error("Automation not found");

    const oldKeyId = trigger.api_key_id;

    const created = await ctx.boundAuth.apiKey.create({
      name: `webhook:${automation.name}:${trigger.id.slice(0, 8)}`,
      permissions: { [webhookPermissionResource(trigger.id)]: ["FIRE"] },
      metadata: {
        kind: "webhook_trigger",
        automation_id: automation.id,
        trigger_id: trigger.id,
      },
    });

    await ctx.storage.automations.setTriggerApiKeyId(trigger.id, created.id);

    if (oldKeyId) {
      try {
        await ctx.boundAuth.apiKey.delete(oldKeyId);
      } catch (err) {
        console.warn(
          `[trigger-rotate] failed to delete old key ${oldKeyId} for trigger ${trigger.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return {
      trigger_id: trigger.id,
      url: webhookUrl(ctx.baseUrl, organization.slug, trigger.id),
      token: created.key,
    };
  },
});
