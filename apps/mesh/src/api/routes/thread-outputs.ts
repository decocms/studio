/**
 * Thread Outputs Route
 *
 * Lists files the model has shared back to the user via the
 * `share_with_user` tool. Files live under `model-outputs/<thread_id>/`
 * and the chat UI polls this endpoint on assistant-turn completion to
 * render download chips on the producing turn.
 *
 * Route: GET /api/threads/:threadId/outputs
 *
 * Auth: standard `meshContext` user-session middleware. The thread
 * lookup uses `OrgScopedThreadStorage` so an authenticated user can
 * only see threads belonging to their org.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MeshContext } from "@/core/mesh-context";

type Variables = { meshContext: MeshContext };

export const createThreadOutputsRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/threads/:threadId/outputs", async (c) => {
    const ctx = c.get("meshContext");
    const userId = ctx.auth?.user?.id;
    if (!userId) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const orgSlug = ctx.organization?.slug;
    if (!orgSlug) {
      throw new HTTPException(400, { message: "Organization required" });
    }

    const threadId = c.req.param("threadId");
    // Allow-list — every thread-id format the codebase produces (nanoid
    // / UUID) fits these chars. Stricter than the legacy deny-list in
    // validateThreadAccess (which only blocks `.*> \s`) and clearer
    // about intent. Downstream usage is parameterised SQL + S3 prefix
    // listing so this is hygiene, not a security boundary.
    if (!threadId || !/^[A-Za-z0-9_-]+$/.test(threadId)) {
      throw new HTTPException(400, { message: "Invalid thread ID" });
    }

    const thread = await ctx.storage.threads.get(threadId);
    if (!thread) {
      throw new HTTPException(404, { message: "Thread not found" });
    }

    const storage = ctx.objectStorage;
    if (!storage) {
      return c.json({ objects: [] });
    }
    const result = await storage.list({
      prefix: `model-outputs/${threadId}/`,
      maxKeys: 200,
    });

    // Use ctx.baseUrl (canonical, set during context creation from
    // forwarded-host headers / env) rather than `new URL(c.req.url).origin`
    // — behind a TLS-terminating proxy the latter resolves to the
    // internal listen address, causing a freshly-shared file's
    // share_with_user URL (which already uses ctx.baseUrl) to disagree
    // with subsequent listings.
    return c.json({
      objects: result.objects.map((o) => {
        const filename = o.key.split("/").pop() ?? o.key;
        // Encode each path segment — keys may carry URL-special chars
        // (?, #, &, space) and `c.req.path` in the files route truncates
        // at the first unescaped `?`.
        const encodedKey = o.key.split("/").map(encodeURIComponent).join("/");
        return {
          key: o.key,
          filename,
          size: o.size,
          uploadedAt: o.lastModified?.toISOString(),
          downloadUrl: `${ctx.baseUrl}/api/${encodeURIComponent(orgSlug)}/files/${encodedKey}`,
        };
      }),
    });
  });

  return app;
};
