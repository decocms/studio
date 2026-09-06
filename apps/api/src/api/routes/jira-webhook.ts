/**
 * POST /api/_jira/webhook/:secret — Jira issue-event intake, per org.
 *
 * The trigger behind the integration: an `issue_updated` event whose changelog
 * carries a status change is checked against the org's rules and, when one
 * matches, starts an agent run on the issue (`jira/trigger.ts`). Everything
 * else is acknowledged and dropped.
 *
 * Jira admin webhooks carry no HMAC signature, so the per-org secret in the
 * path is the whole authentication; the payload is parsed but never trusted
 * for anything the trigger does not re-read from Jira with the integration's
 * own credential. Answers 202 before doing the work: Jira times a hook out in
 * seconds and the dispatch reads the issue, its comments and a quota row.
 *
 * Instance-level (underscore namespace, mounted before the /api/:org
 * catch-all) and outside session auth, like the GitHub/Stripe intakes.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Kysely } from "kysely";
import { CredentialVault } from "@/encryption/credential-vault";
import {
  parseWebhookTransition,
  triggerRunForTransition,
} from "@/jira/trigger";
import { JiraIntegrationStorage } from "@/storage/jira-integrations";
import type { Database } from "@/storage/types";
import { buildOrgContext } from "@/tools/task-board/org-context";

/** The route is unauthenticated until the secret lookup — cap the body. */
const MAX_BODY_SIZE = 1_048_576; // 1MB

export function createJiraWebhookRoutes(deps: {
  db: Kysely<Database>;
  encryptionKey: string;
}): Hono {
  const storage = new JiraIntegrationStorage(
    deps.db,
    new CredentialVault(deps.encryptionKey),
  );

  async function run(secret: string, payload: unknown): Promise<void> {
    const transition = parseWebhookTransition(payload);
    if (!transition) return;
    // Re-fetched here rather than trusted from the ack: config may have changed.
    const integration = await storage.getByWebhookSecret(secret);
    if (!integration?.enabled) return;
    const ctx = await buildOrgContext(deps.db, integration.organizationId);
    if (!ctx) return;
    const outcome = await triggerRunForTransition(ctx, integration, transition);
    if (outcome === "started") {
      console.log(
        `[jira-webhook] started a run for ${transition.issueKey} entering "${transition.toStatus}"`,
      );
    }
  }

  const app = new Hono();
  app.post(
    "/webhook/:secret",
    bodyLimit({ maxSize: MAX_BODY_SIZE }),
    async (c) => {
      const secret = c.req.param("secret");
      const integration = await storage.getByWebhookSecret(secret);
      if (!integration) return c.json({ error: "Unknown webhook" }, 404);
      let payload: unknown;
      try {
        payload = await c.req.json();
      } catch {
        return c.json({ error: "Body must be JSON" }, 400);
      }
      void run(secret, payload).catch((err) => {
        console.error("[jira-webhook] trigger failed", err);
      });
      return c.body(null, 202);
    },
  );
  return app;
}
