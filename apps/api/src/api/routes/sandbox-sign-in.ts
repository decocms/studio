/**
 * Sandbox sign-in for MCP servers that accept only Claude Code's OAuth client
 * (see `signsInFromSandbox`). Claude Code signs in inside a short-lived
 * sandbox; finish hands the grant back to the browser, which stores it with
 * POST /connections/:id/oauth-token like any other OAuth result.
 */

import { getDecopilotId, signsInFromSandbox } from "@decocms/shared/sdk";
import { Hono } from "hono";
import { z } from "zod";
import type { StudioContext } from "../../core/studio-context";
import { resolveOriginTokenEndpoint } from "../../oauth/resolve-token-endpoint";
import { getAgentSandboxProvider } from "../../sandbox/lifecycle";
import { ensureSandbox } from "../../tools/sandbox/start";

type Variables = { studioContext: StudioContext };

// One sign-in sandbox per user; the provider resolves the same one on finish.
const SIGN_IN_BRANCH = "mcp-sign-in";

const grantSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  scope: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

/** Claude Code's stored grant, in the shape POST oauth-token takes. */
export function tokenInfoFromGrant(
  grant: z.infer<typeof grantSchema>,
  tokenEndpoint: string | null,
  now = Date.now(),
) {
  return {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken ?? null,
    expiresIn:
      grant.expiresAt === undefined
        ? null
        : Math.max(0, Math.floor((grant.expiresAt - now) / 1000)),
    scope: grant.scope ?? null,
    clientId: grant.clientId ?? null,
    clientSecret: grant.clientSecret ?? null,
    tokenEndpoint,
  };
}

/** Studio-side checks, then the sign-in sandbox (booted on first use). */
async function signInSandbox(ctx: StudioContext, connectionId: string) {
  const organizationId = ctx.organization?.id;
  if (!ctx.auth.user?.id || !organizationId) {
    return { error: "Unauthorized", status: 401 } as const;
  }
  const connection = await ctx.storage.connections.findById(
    connectionId,
    organizationId,
  );
  const url = connection?.connection_url;
  if (!url || !signsInFromSandbox(url)) {
    return { error: "Not a sandbox sign-in connection", status: 404 } as const;
  }
  const sandbox = await ensureSandbox(
    {
      virtualMcpId: getDecopilotId(organizationId),
      branch: SIGN_IN_BRANCH,
      purpose: "harness-run",
    },
    ctx,
  );
  const provider = await getAgentSandboxProvider(ctx);
  const daemon = (path: string, body: unknown) =>
    provider.proxyDaemonRequest(sandbox.sandboxHandle, path, {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
  return { url, daemon, provider, handle: sandbox.sandboxHandle };
}

export const createSandboxSignInRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  /** Returns `{ authUrl }` to open in the user's browser. */
  app.post("/connections/:connectionId/sandbox-sign-in", async (c) => {
    const s = await signInSandbox(
      c.get("studioContext"),
      c.req.param("connectionId"),
    );
    if ("error" in s) return c.json({ error: s.error }, s.status);
    const res = await s.daemon("/_sandbox/mcp-login", {
      name: "server",
      url: s.url,
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  });

  /** Body `{ callbackUrl }`; returns the grant for POST oauth-token. */
  app.post("/connections/:connectionId/sandbox-sign-in/finish", async (c) => {
    const s = await signInSandbox(
      c.get("studioContext"),
      c.req.param("connectionId"),
    );
    if ("error" in s) return c.json({ error: s.error }, s.status);
    const res = await s.daemon(
      "/_sandbox/mcp-login/finish",
      await c.req.json<unknown>().catch(() => ({})),
    );
    if (!res.ok) {
      return new Response(res.body, {
        status: res.status,
        headers: res.headers,
      });
    }
    const grant = grantSchema.safeParse(await res.json().catch(() => null));
    if (!grant.success) {
      return c.json({ error: "Sign-in returned no token" }, 502);
    }
    await s.provider.delete(s.handle).catch((err) => {
      console.warn(
        "[sandbox-sign-in] failed to delete the sign-in sandbox",
        err instanceof Error ? err.message : String(err),
      );
    });
    const tokenEndpoint = await resolveOriginTokenEndpoint(s.url);
    return c.json(tokenInfoFromGrant(grant.data, tokenEndpoint));
  });

  return app;
};
