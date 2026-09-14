/**
 * Tells the WhatsApp Concierge bot (repo `decocms/concierge`) that a lead it
 * referred has converted, closing the WhatsApp → signup loop in its funnel
 * report. See https://github.com/decocms/studio/issues/3747.
 */

import { getSettings } from "../settings";

/**
 * POSTs the signup conversion for `ref` (the Concierge's opaque per-lead id,
 * captured as a first-party cookie by the web client on landing). Idempotent
 * on the Concierge's side, so no retry logic lives here.
 *
 * Best-effort: throws on a genuine failure (non-2xx, not-404 — a 404 just
 * means no lead matched `ref`) so the caller can log it, but a signup must
 * never fail or block because of this call — callers must not let a
 * rejection propagate into the signup flow.
 */
export async function notifyConciergeSignup(ref: string): Promise<void> {
  const settings = getSettings();
  if (!settings.conciergeAuthToken) return;

  const res = await fetch(`${settings.conciergeUrl}/event`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.conciergeAuthToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "signup", ref }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`concierge signup notify failed (${res.status}): ${text}`);
  }
}
