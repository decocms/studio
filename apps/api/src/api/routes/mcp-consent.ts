/**
 * Backing endpoints for the MCP OAuth consent page (`/oauth/consent`).
 *
 *   GET  /api/auth/custom/mcp-consent   describe the client asking for access
 *   POST /api/auth/custom/mcp-consent   record the signed-in user's approval
 *
 * The page then sends the browser back to `/api/auth/mcp/authorize`, whose
 * consent hook now lets the code through.
 */

import { Hono } from "hono";
import { z } from "zod";
import { auth } from "../../auth";
import { parseScopes } from "../../auth/mcp-consent";

interface ClientRow {
  clientId: string;
  name: string | null;
  redirectUrls: string;
  disabled: boolean | null;
}

interface ConsentRow {
  id: string;
  scopes: string | null;
}

const describeQuery = z.object({
  client_id: z.string().min(1).max(256),
  redirect_uri: z.string().min(1).max(2048),
  scope: z.string().max(1024).optional(),
});

const grantBody = z.object({
  client_id: z.string().min(1).max(256),
  scope: z.string().max(1024).optional(),
});

async function findClient(clientId: string): Promise<ClientRow | null> {
  const ctx = await auth.$context;
  const client = await ctx.adapter.findOne<ClientRow>({
    model: "oauthApplication",
    where: [{ field: "clientId", value: clientId }],
  });
  return client && !client.disabled ? client : null;
}

/** `scheme://host` for display; a native app scheme has no web origin. */
function redirectTarget(raw: string): string {
  const url = new URL(raw);
  return url.host ? `${url.protocol}//${url.host}` : url.protocol;
}

const app = new Hono();

app.get("/", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const parsed = describeQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
  const { client_id, redirect_uri, scope } = parsed.data;

  const client = await findClient(client_id);
  if (!client) return c.json({ error: "Unknown client" }, 404);
  if (!client.redirectUrls.split(",").includes(redirect_uri)) {
    return c.json({ error: "redirect_uri is not registered" }, 400);
  }

  return c.json({
    clientName: client.name,
    redirectTarget: redirectTarget(redirect_uri),
    scopes: parseScopes(scope),
  });
});

app.post("/", async (c) => {
  // A JSON body forces a CORS preflight; Fetch Metadata rejects the rest.
  const mediaType = c.req.header("content-type")?.split(";")[0]?.trim();
  if (mediaType?.toLowerCase() !== "application/json") {
    return c.json({ error: "Content-Type must be application/json" }, 415);
  }
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const parsed = grantBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
  const { client_id, scope } = parsed.data;

  if (!(await findClient(client_id))) {
    return c.json({ error: "Unknown client" }, 404);
  }

  const ctx = await auth.$context;
  const where = [
    { field: "clientId", value: client_id },
    { field: "userId", value: session.user.id },
  ];
  const existing = await ctx.adapter.findOne<ConsentRow>({
    model: "oauthConsent",
    where,
  });
  const scopes = new Set([
    ...(existing?.scopes?.split(" ").filter(Boolean) ?? []),
    ...parseScopes(scope),
  ]);
  const now = new Date();
  if (existing) {
    await ctx.adapter.update({
      model: "oauthConsent",
      where: [{ field: "id", value: existing.id }],
      update: {
        scopes: [...scopes].join(" "),
        consentGiven: true,
        updatedAt: now,
      },
    });
  } else {
    await ctx.adapter.create({
      model: "oauthConsent",
      data: {
        clientId: client_id,
        userId: session.user.id,
        scopes: [...scopes].join(" "),
        consentGiven: true,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  return c.body(null, 204);
});

export default app;
