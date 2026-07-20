import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * A better-auth / better-call APIError, matched by SHAPE not `instanceof`.
 * better-call is present in several copies (better-auth bundles its own), so the
 * APIError class thrown by the auth plugins isn't identical to one we'd import —
 * `instanceof` silently misses and the error 500s. Every copy's constructor sets
 * `this.name = "APIError"` (verified in better-call error.mjs, both 1.x and 2.x),
 * so `name === "APIError"` + a numeric 4xx/5xx `statusCode` is the reliable
 * cross-copy discriminator. The name check is what keeps this from misfiring on
 * foreign errors that merely happen to carry a `statusCode` (e.g. the AI SDK's
 * `AI_APICallError`), relabeling an upstream 5xx as our own client-facing 4xx.
 */
function asApiError(
  err: unknown,
): { statusCode: number; body?: { message?: string; code?: string } } | null {
  if (!(err instanceof Error) || err.name !== "APIError") return null;
  const code = (err as { statusCode?: unknown }).statusCode;
  if (typeof code !== "number" || code < 400 || code >= 600) return null;
  return err as unknown as {
    statusCode: number;
    body?: { message?: string; code?: string };
  };
}

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
 * Better Auth `APIError`s likewise carry an intended status + body. Routes that
 * call `auth.api.*` in-process (e.g. the deployment-admin addMember on a bad
 * orgId) let these propagate; honoring `statusCode` turns them into the right
 * 4xx instead of a misleading 500. Only `message`/`code` are forwarded — never
 * `body.cause`, which can hold internals.
 *
 * NOTE this mapping is GLOBAL (app.onError): every route on the API surface
 * that lets an APIError bubble now returns better-auth's real status and
 * message text to the client, where it previously flattened to an opaque 500.
 * That exposure is deliberate — these are user-facing auth errors by design.
 *
 * Anything else is a genuine unexpected failure → logged + 500.
 */
export function handleApiError(err: unknown, c: Context): Response {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  const apiErr = asApiError(err);
  if (apiErr) {
    const body = apiErr.body ?? {};
    return Response.json(
      { error: body.message ?? (err as Error).message, code: body.code },
      { status: apiErr.statusCode },
    );
  }

  console.error("Server error :", err);
  const message = err instanceof Error ? err.message : "Unknown error";
  return c.json({ error: "Internal Server Error", message }, 500);
}
