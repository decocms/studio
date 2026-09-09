/**
 * `/api/_github/webhook`'s PR-card contract, over the wire.
 *
 * A PR card's checks and preview url used to be poll-only, so they landed
 * minutes after GitHub had them. GitHub now posts `check_suite` /
 * `issue_comment` here, which re-reads the card and pushes it on the org's
 * `/watch` stream.
 *
 * What this spec covers is the route's own contract: authentication, and which
 * deliveries are worth a provider read at all. That second half is the one that
 * costs money — every refresh is an UNCACHED read, and polling this same state
 * too hard is what took the App's rate limit out (see #7094).
 *
 * NOT covered here: the full delivery → reverse lookup → fresh read → SSE →
 * dialog chain. It needs a stub for the provider read the card path now makes
 * (a GraphQL detail query through `git-providers`, not the `mcp-github`
 * connection this spec originally stubbed), which the suite has no fixture for
 * yet — `github-stub.ts` covers Git Data and pulls only.
 *
 * `GITHUB_WEBHOOK_SECRET` is set on the API server by playwright.config.ts;
 * the literal is duplicated here by hand (the config isn't a spec module),
 * matching how commerce-diagnostic-share.spec.ts carries the vault token.
 */

import { createHmac } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../fixtures/test";

const WEBHOOK_SECRET = "e2e-github-webhook-secret";

/** GitHub's own signature scheme: HMAC-SHA256 over the exact request bytes. */
function sign(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
}

function postWebhook(
  request: APIRequestContext,
  event: string,
  payload: unknown,
  signature?: string,
) {
  const body = JSON.stringify(payload);
  return request.post("/api/_github/webhook", {
    data: body,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": signature ?? sign(body),
    },
  });
}

test.describe("github webhook → PR card", () => {
  test("authenticates by HMAC and refreshes nothing it should not", async ({
    authedPage,
  }) => {
    const request = authedPage.page.context().request;
    const repository = {
      name: "nobody-links-me",
      owner: { login: "acme-e2e" },
    };

    // The route's only authentication is the HMAC — a wrong one is a 400, and
    // must not be treated as an unsigned-but-harmless ping.
    const forged = await postWebhook(
      request,
      "check_suite",
      { repository },
      "sha256=" + "0".repeat(64),
    );
    expect(forged.status()).toBe(400);

    // An event nobody consumes is a 200: GitHub retries non-2xx, and there is
    // nothing here to retry.
    const unhandled = await postWebhook(request, "star", { repository });
    expect(unhandled.status()).toBe(200);
    expect(await unhandled.json()).toMatchObject({ ignored: "event" });

    // A suite that has not finished says only "pending", which the card already
    // shows — so it must NOT buy an uncached provider read. A suite fires on
    // `requested` and `rerequested` too, so honouring them would triple this
    // path's cost for no new information.
    for (const action of ["requested", "rerequested"]) {
      const midFlight = await postWebhook(request, "check_suite", {
        action,
        repository,
        check_suite: { pull_requests: [{ number: 1 }] },
      });
      expect(midFlight.status()).toBe(200);
      expect(await midFlight.json()).toMatchObject({ ignored: "no-pr" });
    }

    // A comment on a plain ISSUE is not a PR event — no `pull_request` key.
    const onIssue = await postWebhook(request, "issue_comment", {
      action: "created",
      repository,
      issue: { number: 1 },
    });
    expect(await onIssue.json()).toMatchObject({ ignored: "no-pr" });

    // A finished suite for a repo no card links: the indexed lookup finds
    // nothing and the delivery still succeeds. This is the common case in prod,
    // where the App is installed on far more repos than the board tracks.
    const unlinked = await postWebhook(request, "check_suite", {
      action: "completed",
      repository,
      check_suite: { pull_requests: [{ number: 1 }] },
    });
    expect(await unlinked.json()).toMatchObject({ ok: true, refreshed: 0 });
  });
});
