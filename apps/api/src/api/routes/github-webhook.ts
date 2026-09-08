/**
 * POST /api/_github/webhook — GitHub event intake.
 *
 * Two consumers, one endpoint (GitHub Apps have exactly one webhook url):
 *  - `push` refreshes tenant warm pools.
 *  - `check_suite` / `issue_comment` re-read the task board PR cards for the
 *    PR the event names, so CI results and a deploy bot's preview url reach the
 *    open dialog in about a second instead of on a poll.
 *
 * OPTIONAL everywhere. Without `GITHUB_WEBHOOK_SECRET` the route answers 503
 * and both consumers still catch up on their own polling. Instance-level
 * (underscore namespace, mounted before the /api/:org catch-all) and outside
 * session auth: the caller is GitHub, authenticated exclusively by the HMAC
 * over the RAW body.
 */

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getOrInitSharedRunner } from "@/sandbox/lifecycle";
import type { StudioContextFactory } from "@/automations/fire";
import type { TaskBoardStorage } from "@/storage/task-board";
import { refreshItemPrCards } from "@/tools/task-board/prs-get";

// A push event with a large commit list is still small; the route is
// unauthenticated, so cap the body before buffering it.
const MAX_BODY_SIZE = 5_242_880; // 5MB

/** Events that can change a PR card. `check_suite` covers third-party checks
 *  (Cloudflare Pages / Workers Builds) as well as Actions; `issue_comment`
 *  carries the deploy bots that publish the preview url as a comment. */
const PR_CARD_EVENTS = new Set(["check_suite", "issue_comment"]);

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

export interface GithubPrEventRef {
  repoOwner: string;
  repoName: string;
  number: number;
}

/**
 * Which PRs an event is about. A `check_suite` names them in `pull_requests[]`
 * (empty for a push to a branch with no PR — nothing to refresh). An
 * `issue_comment` is about a PR only when the issue carries a `pull_request`
 * key; a comment on a plain issue is not one.
 *
 * Pure, so the payload shapes are unit-tested without a server. Exported for
 * that test.
 */
export function prRefsFromGithubEvent(
  event: string,
  payload: unknown,
): GithubPrEventRef[] {
  const body = payload as {
    repository?: { name?: unknown; owner?: { login?: unknown } };
    check_suite?: { pull_requests?: unknown };
    issue?: { number?: unknown; pull_request?: unknown };
  };
  const repoName = body?.repository?.name;
  const repoOwner = body?.repository?.owner?.login;
  if (typeof repoName !== "string" || typeof repoOwner !== "string") return [];
  const numbers: number[] = [];
  if (event === "check_suite") {
    const prs = body.check_suite?.pull_requests;
    for (const pr of Array.isArray(prs) ? prs : []) {
      const n = (pr as { number?: unknown })?.number;
      if (typeof n === "number") numbers.push(n);
    }
  } else if (event === "issue_comment" && body.issue?.pull_request) {
    const n = body.issue.number;
    if (typeof n === "number") numbers.push(n);
  }
  return [...new Set(numbers)].map((number) => ({
    repoOwner,
    repoName,
    number,
  }));
}

/** Resolved lazily: the route is mounted before the /api/:org catch-all, which
 *  is earlier than where the storage and the context factory are built. */
export interface GithubWebhookDeps {
  taskBoard: () => TaskBoardStorage;
  contextFactory: () => StudioContextFactory;
}

export function createGithubWebhookRoutes(deps: GithubWebhookDeps): Hono {
  const routes = new Hono();

  routes.post(
    "/webhook",
    bodyLimit({
      maxSize: MAX_BODY_SIZE,
      onError: (c) => c.json({ error: "payload too large" }, 413),
    }),
    async (c) => {
      const secret = process.env.GITHUB_WEBHOOK_SECRET;
      if (!secret) {
        return c.json({ error: "github webhook not configured" }, 503);
      }

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

      const event = c.req.header("x-github-event");
      // 200-and-ignore everything we don't handle: GitHub retries on non-2xx,
      // and there is nothing to retry for an event nobody consumes.
      if (event !== "push" && !PR_CARD_EVENTS.has(event ?? "")) {
        return c.json({ ok: true, ignored: "event" });
      }

      let payload: {
        ref?: string;
        repository?: { full_name?: string };
      };
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return c.json({ error: "invalid payload" }, 400);
      }

      if (event === "push") {
        const ref = payload.ref;
        const repo = payload.repository?.full_name;
        if (!ref || !repo) return c.json({ ok: true, ignored: "shape" });
        const runner = await getOrInitSharedRunner();
        // The pool reconciler refreshes on its next tick; nothing waits here.
        const pools = runner?.markTenantPoolsDirty(repo, ref) ?? [];
        return c.json({ ok: true, pools });
      }

      const refs = prRefsFromGithubEvent(event ?? "", payload);
      if (refs.length === 0) return c.json({ ok: true, ignored: "shape" });
      const refreshed = await refreshPrCardsForRefs(deps, refs);
      return c.json({ ok: true, refreshed });
    },
  );

  return routes;
}

/**
 * Refresh every task card linked to any of `refs`. Almost always zero: the App
 * is installed on far more repos than the board links PRs from, so the indexed
 * lookup is the whole cost of an event nobody is watching.
 *
 * Awaited rather than detached so GitHub's delivery log reflects whether the
 * work actually happened — the deliveries page is the only debugging surface
 * this path has.
 */
async function refreshPrCardsForRefs(
  deps: GithubWebhookDeps,
  refs: GithubPrEventRef[],
): Promise<number> {
  let refreshed = 0;
  for (const ref of refs) {
    try {
      const taskBoard = deps.taskBoard();
      const links = await taskBoard.findPrLinks(ref);
      for (const link of links) {
        const item = await taskBoard.getById(
          link.taskBoardItemId,
          link.organizationId,
        );
        // The context is the org's, built from the card's owner: a webhook has
        // no principal of its own, and the GitHub connection it reads through
        // is the organization's.
        const ctx = item
          ? await deps.contextFactory()(
              link.organizationId,
              item.assignedBy ?? item.createdBy,
            )
          : null;
        if (!ctx) continue;
        const cards = await refreshItemPrCards(
          ctx,
          link.organizationId,
          link.taskBoardItemId,
        );
        if (cards !== null) refreshed++;
      }
    } catch (err) {
      // Same reason `refreshItemPrCards` swallows its own: a 500 here makes
      // GitHub retry the delivery, and a database blip is not something a
      // replay fixes. The count in the response is the signal instead.
      console.error("[github-webhook] pr card refresh failed:", err);
    }
  }
  return refreshed;
}
