/**
 * POST /api/_github/webhook — GitHub push intake for tenant warm pools.
 *
 * OPTIONAL everywhere. Without `GITHUB_WEBHOOK_SECRET` the route answers 503
 * and warm pools still pick up new commits on their periodic refresh — the
 * webhook only makes that immediate. Instance-level (underscore namespace,
 * mounted before the /api/:org catch-all) and outside session auth: the caller
 * is GitHub, authenticated exclusively by the HMAC over the RAW body.
 */

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getOrInitSharedRunner } from "@/sandbox/lifecycle";

// A push event with a large commit list is still small; the route is
// unauthenticated, so cap the body before buffering it.
const MAX_BODY_SIZE = 5_242_880; // 5MB

export function verifyGithubSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = new Bun.CryptoHasher("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const received = header.slice("sha256=".length);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

export const githubWebhookRoutes = new Hono();

/**
 * Runners that keep per-tenant warm pools. A predicate, not an `as`-cast, so a
 * rename breaks the build instead of emptying the pool list forever.
 */
interface TenantPoolRefresher {
  markTenantPoolsDirty(repo: string, ref: string): string[];
}

function refreshesTenantPools(runner: unknown): runner is TenantPoolRefresher {
  return (
    typeof (runner as TenantPoolRefresher | null | undefined)
      ?.markTenantPoolsDirty === "function"
  );
}

githubWebhookRoutes.post(
  "/webhook",
  bodyLimit({
    maxSize: MAX_BODY_SIZE,
    onError: (c) => c.json({ error: "payload too large" }, 413),
  }),
  async (c) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "github webhook not configured" }, 503);

    // Raw body FIRST — the signature covers the exact bytes.
    const rawBody = await c.req.text();
    if (
      !verifyGithubSignature(
        rawBody,
        c.req.header("x-hub-signature-256"),
        secret,
      )
    ) {
      return c.json({ error: "invalid signature" }, 400);
    }

    // 200-and-ignore everything that isn't a push: GitHub retries on non-2xx,
    // and there is nothing to retry for an event we don't handle.
    if (c.req.header("x-github-event") !== "push") {
      return c.json({ ok: true, ignored: "event" });
    }

    let payload: { ref?: string; repository?: { full_name?: string } };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "invalid payload" }, 400);
    }
    const ref = payload.ref;
    const repo = payload.repository?.full_name;
    if (!ref || !repo) return c.json({ ok: true, ignored: "shape" });

    const runner = await getOrInitSharedRunner();
    // Only the agent-sandbox runner has pools; the reconciler picks these up.
    const pools = refreshesTenantPools(runner)
      ? runner.markTenantPoolsDirty(repo, ref)
      : [];
    return c.json({ ok: true, pools });
  },
);
