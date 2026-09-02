/**
 * Jira attachment bytes, proxied with the connection's vaulted OAuth token.
 *
 * `GET /api/:org/connections/:connectionId/jira/attachments/:attachmentId`
 *
 * Why this route exists: a sandbox run can enumerate a Jira attachment through
 * the Atlassian MCP (`getJiraIssue` → `fields.attachment[]`) but cannot fetch
 * one — the bytes need an Atlassian bearer token, the MCP exposes no
 * fetch-the-bytes tool, and the connection's token stays in Studio's vault by
 * design (`/oauth-token` returns only a *status*, never a value). Handing the
 * token to the pod instead would put a live third-party credential in a shell,
 * a transcript, and a log; proxying the bytes keeps it here.
 *
 * The caller needs no new credential: a run already holds a Studio API key and
 * the daemon writes it to `<repo>/.deco/tools/.endpoint.json`, so the agent can
 * call this over plain HTTPS. Sandbox egress allows any public host on TCP/443
 * (port-based `netinit` iptables), so the public URL is reachable.
 *
 * ⚠️ SECURITY: this route spends someone else's OAuth token. Two guards are
 * load-bearing and both fail closed:
 *   1. the connection must be an ATLASSIAN one — otherwise we would ship, say,
 *      a Notion token to `api.atlassian.com`;
 *   2. the target host is fixed (`api.atlassian.com`) and the cloudId is
 *      validated against what the token can actually see, so the path cannot
 *      be steered at an arbitrary URL.
 * Never log the token, and never put a response body in an error message.
 */

import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import { ForbiddenError, UnauthorizedError } from "@/core/access-control";
import { getValidDownstreamAccessToken } from "@/oauth/token-refresh";
import { DownstreamTokenStorage } from "@/storage/downstream-token";
import {
  ATLASSIAN_API_HOST,
  type AccessibleResource,
  attachmentContentUrl,
  isAtlassianUrl,
  MAX_ATTACHMENT_BYTES,
  parseAttachmentId,
  resolveCloudId,
  safeContentDisposition,
  UPSTREAM_TIMEOUT_MS,
} from "./jira-attachment-targets";

type Variables = { studioContext: StudioContext };

/**
 * Resource key gating this route. Not an MCP tool, so it lives in
 * `BASIC_USAGE_TOOLS` next to the org-fs keys rather than in a capability's
 * tool list — same decision, same reason: any org member who can read the
 * issue through the connection can already see the attachment, so the gate is
 * membership. An API key must still name it (or `*`), so a narrowly-scoped key
 * fails closed.
 *
 * Duplicated as a literal in `BASIC_USAGE_TOOLS` rather than imported from it:
 * `packages/shared` must not import app source (`ban-cross-tree-imports`), and
 * the org-fs keys next to it are spelled the same way for the same reason.
 */
const JIRA_ATTACHMENT_READ = "JIRA_ATTACHMENT_READ";

/** Fetch the token's accessible Atlassian sites. */
async function fetchAccessibleResources(
  accessToken: string,
): Promise<AccessibleResource[] | null> {
  const res = await fetch(
    `https://${ATLASSIAN_API_HOST}/oauth/token/accessible-resources`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    },
  );
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as unknown;
  if (!Array.isArray(body)) return null;
  return body.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const id = (entry as Record<string, unknown>).id;
    if (typeof id !== "string" || !id) return [];
    const url = (entry as Record<string, unknown>).url;
    const name = (entry as Record<string, unknown>).name;
    return [
      {
        id,
        ...(typeof url === "string" ? { url } : {}),
        ...(typeof name === "string" ? { name } : {}),
      },
    ];
  });
}

export const createJiraAttachmentRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.get(
    "/connections/:connectionId/jira/attachments/:attachmentId",
    async (c) => {
      const ctx = c.get("studioContext");
      const connectionId = c.req.param("connectionId");

      const userId = ctx.auth?.user?.id ?? ctx.auth?.apiKey?.userId ?? null;
      if (!userId) return c.json({ error: "Unauthorized" }, 401);

      const organizationId = ctx.organization?.id;
      if (!organizationId) {
        return c.json({ error: "Organization context required" }, 403);
      }

      const attachmentId = parseAttachmentId(c.req.param("attachmentId"));
      if (!attachmentId) {
        return c.json(
          { error: "attachmentId must be the numeric Jira attachment id" },
          400,
        );
      }

      try {
        await ctx.access.check(JIRA_ATTACHMENT_READ);
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          return c.json({ error: err.message }, 401);
        }
        if (err instanceof ForbiddenError) {
          return c.json({ error: err.message }, 403);
        }
        throw err;
      }

      const connection = await ctx.storage.connections.findById(
        connectionId,
        organizationId,
      );
      if (!connection) return c.json({ error: "Connection not found" }, 404);
      if (connection.status !== "active") {
        return c.json({ error: "Connection is not active" }, 409);
      }
      // Guard 1: never spend a non-Atlassian connection's token against
      // Atlassian. Fails closed on a null/unparseable url.
      if (!isAtlassianUrl(connection.connection_url)) {
        return c.json(
          {
            error:
              "Not an Atlassian connection — refusing to use its credential",
          },
          400,
        );
      }

      const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
      const token = await getValidDownstreamAccessToken({
        connectionId,
        connectionUrl: connection.connection_url,
        tokenStorage,
      });
      if (!token.accessToken) {
        return c.json(
          {
            error: `No usable Atlassian credential for this connection (${token.state}). Reconnect it in Studio.`,
          },
          409,
        );
      }

      const accessible = await fetchAccessibleResources(token.accessToken);
      if (!accessible) {
        return c.json(
          { error: "Could not list the connection's Atlassian sites" },
          502,
        );
      }
      // Guard 2: the site must be one this token can see, so the upstream URL
      // is not steerable by the caller.
      const site = resolveCloudId(c.req.query("cloudId"), accessible);
      if (!site.ok) return c.json({ error: site.error }, site.status);

      // The content endpoint 303s to Atlassian's media CDN. Followed by hand,
      // one hop, host-checked: an automatic follow would carry the request
      // wherever the Location header points.
      const first = await fetch(
        attachmentContentUrl(site.cloudId, attachmentId),
        {
          headers: { authorization: `Bearer ${token.accessToken}` },
          redirect: "manual",
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        },
      );

      let upstream = first;
      if (first.status >= 300 && first.status < 400) {
        const location = first.headers.get("location");
        if (!isAtlassianUrl(location)) {
          return c.json(
            {
              error: "Attachment redirect left Atlassian — refusing to follow",
            },
            502,
          );
        }
        upstream = await fetch(location as string, {
          // The media URL carries its own credential; ours must not ride along
          // to a different host.
          redirect: "manual",
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
      }

      if (upstream.status === 404) {
        return c.json({ error: "Attachment not found" }, 404);
      }
      if (upstream.status === 401 || upstream.status === 403) {
        return c.json(
          { error: "Atlassian refused the attachment for this connection" },
          403,
        );
      }
      if (!upstream.ok || !upstream.body) {
        return c.json(
          {
            error: `Atlassian returned ${upstream.status} for this attachment`,
          },
          502,
        );
      }

      const declared = Number(upstream.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
        return c.json(
          {
            error: `Attachment is ${declared} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte proxy limit`,
          },
          413,
        );
      }

      const headers: Record<string, string> = {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/octet-stream",
        "Content-Disposition": safeContentDisposition(
          upstream.headers.get("content-disposition"),
          attachmentId,
        ),
        // Never cached by a shared cache: the bytes are a tenant's issue data.
        "Cache-Control": "private, max-age=0, no-store",
      };
      if (Number.isFinite(declared) && declared > 0) {
        headers["Content-Length"] = String(declared);
      }
      return new Response(upstream.body, { status: 200, headers });
    },
  );

  return app;
};
