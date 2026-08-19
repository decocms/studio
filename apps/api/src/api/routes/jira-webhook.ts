/**
 * POST /api/_jira/webhook/:secret — Jira issue-event intake, per org.
 *
 * A wake-up signal, not a data channel: Jira admin webhooks carry no HMAC
 * signature (the per-org secret in the path is the whole authentication), so
 * the payload is never trusted or even parsed — receiving one just schedules
 * the same incremental pull sync the 10-minute cron runs, debounced so a
 * burst of issue edits costs one Jira round-trip. Losing a webhook therefore
 * only costs latency: the cron re-covers everything.
 *
 * Instance-level (underscore namespace, mounted before the /api/:org
 * catch-all) and outside session auth, like the GitHub/Stripe intakes.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Kysely } from "kysely";
import { CredentialVault } from "@/encryption/credential-vault";
import { syncJiraIntegrationSafe } from "@/jira/sync";
import { JiraIntegrationStorage } from "@/storage/jira-integrations";
import type { Database } from "@/storage/types";
import { buildOrgContext } from "@/tools/task-board/org-context";

/** The route is unauthenticated until the secret lookup — cap the body. */
const MAX_BODY_SIZE = 1_048_576; // 1MB

/** Trailing debounce: a bulk edit in Jira fires one webhook per issue; one
 *  sync covers them all via the JQL window. */
const DEBOUNCE_MS = 3_000;

export function createJiraWebhookRoutes(deps: {
  db: Kysely<Database>;
  encryptionKey: string;
}): Hono {
  const storage = new JiraIntegrationStorage(
    deps.db,
    new CredentialVault(deps.encryptionKey),
  );
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleSync(secret: string, integrationId: string): void {
    const existing = pending.get(integrationId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(integrationId);
      void runSync(secret, integrationId);
    }, DEBOUNCE_MS);
    timer.unref?.();
    pending.set(integrationId, timer);
  }

  async function runSync(secret: string, integrationId: string): Promise<void> {
    try {
      // Re-fetch at fire time — config/credentials may have changed in the window.
      const integration = await storage.getByWebhookSecret(secret);
      if (!integration || !integration.enabled) return;
      const ctx = await buildOrgContext(deps.db, integration.organizationId);
      if (!ctx) return;
      const result = await syncJiraIntegrationSafe(ctx, integration);
      if ("error" in result) {
        console.warn(
          `[jira] webhook-triggered sync ${integrationId} failed: ${result.error}`,
        );
      }
    } catch (err) {
      console.warn(
        `[jira] webhook-triggered sync ${integrationId} crashed:`,
        err,
      );
    }
  }

  const app = new Hono();
  app.post(
    "/webhook/:secret",
    bodyLimit({
      maxSize: MAX_BODY_SIZE,
      onError: (c) => c.json({ error: "payload too large" }, 413),
    }),
    async (c) => {
      const secret = c.req.param("secret");
      const integration = await storage.getByWebhookSecret(secret);
      if (!integration) return c.json({ error: "unknown webhook" }, 404);
      // Drain the body so the connection is reusable; content is untrusted.
      await c.req.text().catch(() => "");
      if (!integration.enabled)
        return c.json({ ok: true, ignored: "disabled" });
      scheduleSync(secret, integration.id);
      return c.json({ ok: true });
    },
  );
  return app;
}
