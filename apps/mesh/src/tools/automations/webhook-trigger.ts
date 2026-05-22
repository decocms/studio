/**
 * Shared helpers for webhook automation triggers.
 *
 * Webhook triggers authenticate inbound POSTs with a Better Auth API key
 * scoped to the trigger id via `{ webhook_<trigger_id>: ["FIRE"] }`.
 *
 * Defined here (rather than inline in the route or tools) so the permission
 * key shape stays consistent across trigger creation, rotation, and the
 * webhook callback route.
 */

export function webhookPermissionResource(triggerId: string): string {
  return `webhook_${triggerId}`;
}

export function webhookUrl(
  baseUrl: string,
  orgSlug: string | undefined,
  triggerId: string,
): string {
  if (!orgSlug) {
    throw new Error(
      "Cannot build webhook URL: organization slug missing from request context",
    );
  }
  return `${baseUrl}/api/${orgSlug}/webhooks/${triggerId}`;
}
