import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { APIError } from "better-auth/api";

/**
 * Global API error handler (wired via `app.onError`).
 *
 * `HTTPException`s carry their own status + body (e.g. a route throwing
 * `new HTTPException(404, ...)`), so honor them via `getResponse()` instead of
 * flattening every error to 500. Before this, the handler 500'd *everything*
 * thrown — including HTTPException — so routes like files/file-uploads/
 * thread-outputs that `throw new HTTPException(401|404|...)` silently returned
 * 500.
 *
 * Better Auth / better-call `APIError`s likewise carry an intended status +
 * body. Routes that call `auth.api.*` in-process (e.g. the deployment-admin
 * addMember on a bad orgId) let these propagate; honoring `statusCode` turns
 * them into the right 4xx instead of a misleading 500. Only `message`/`code`
 * are forwarded — never `body.cause`, which can hold internals.
 *
 * Anything else is a genuine unexpected failure → logged + 500.
 */
export function handleApiError(err: unknown, c: Context): Response {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  if (err instanceof APIError) {
    const body = (err.body ?? {}) as { message?: string; code?: string };
    return Response.json(
      { error: body.message ?? err.message, code: body.code },
      { status: err.statusCode || 500 },
    );
  }

  console.error("Server error :", err);
  const message = err instanceof Error ? err.message : "Unknown error";
  return c.json({ error: "Internal Server Error", message }, 500);
}
