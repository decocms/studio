/**
 * GET /api/_jira/attachments/:token — one Jira attachment's bytes, for a run.
 *
 * The sandbox never holds the Jira credential (a live third-party token in a
 * shell, a transcript and a log), so Studio spends it and streams the bytes.
 * The token is a signed, expiring grant to ONE attachment of ONE org, minted
 * by `JIRA_ATTACHMENT_DOWNLOAD` for the run that asked; it is the route's
 * whole authentication, which is why it lives outside session auth next to
 * the webhook intake. Never log the token.
 */

import { Hono } from "hono";
import type { Kysely } from "kysely";
import { CredentialVault } from "@/encryption/credential-vault";
import { verifyAttachmentToken } from "@/jira/attachment-token";
import { JiraClient } from "@/jira/client";
import { JiraIntegrationStorage } from "@/storage/jira-integrations";
import type { Database } from "@/storage/types";

export function createJiraAttachmentRoutes(deps: {
  db: Kysely<Database>;
  encryptionKey: string;
}): Hono {
  const storage = new JiraIntegrationStorage(
    deps.db,
    new CredentialVault(deps.encryptionKey),
  );
  const app = new Hono();
  app.get("/attachments/:token", async (c) => {
    const grant = verifyAttachmentToken(c.req.param("token"));
    if (!grant) return c.json({ error: "Invalid or expired link" }, 404);
    const integration = await storage.getByOrg(grant.organizationId);
    if (!integration) return c.json({ error: "Jira is not connected" }, 404);
    const client = new JiraClient(
      integration.siteUrl,
      integration.email,
      integration.apiToken,
    );
    const upstream = await client.downloadAttachment(grant.attachmentId);
    if (!upstream.ok || !upstream.body) {
      return c.json({ error: "Jira refused the download" }, 502);
    }
    const headers = new Headers();
    for (const name of [
      "content-type",
      "content-length",
      "content-disposition",
    ]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("cache-control", "no-store");
    return new Response(upstream.body, { status: 200, headers });
  });
  return app;
}
