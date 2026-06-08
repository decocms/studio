import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * Global API error handler (wired via `app.onError`).
 *
 * `HTTPException`s carry their own status + body (e.g. a route throwing
 * `new HTTPException(404, ...)`), so honor them via `getResponse()` instead of
 * flattening every error to 500. Before this, the handler 500'd *everything*
 * thrown — including HTTPException — so routes like files/file-uploads/
 * thread-outputs that `throw new HTTPException(401|404|...)` silently returned
 * 500. Anything that isn't an HTTPException is a genuine unexpected failure →
 * logged + 500 with the same JSON shape as before.
 */
export function handleApiError(err: unknown, c: Context): Response {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  console.error("Server error :", err);
  const message = err instanceof Error ? err.message : "Unknown error";
  return c.json({ error: "Internal Server Error", message }, 500);
}
