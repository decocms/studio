/**
 * The card's own pure logic: which preview URL to trust, where to find it in
 * what a provider reported, and when a provider's refusal is a rate limit.
 *
 * Provider-shaped mapping (a pull request's `mergeable_state`, a pipeline's
 * status, a job's conclusion) is NOT here — it lives next to the
 * implementation that owns that vocabulary, in
 * `git-providers/change-requests/`. What is left is the part that is the same
 * whoever answered.
 */
import { describe, expect, it } from "bun:test";
import { GitProviderError } from "@/git-providers/types";
import {
  asHeadSha,
  cardLifecycle,
  isRateLimitError,
  isTrustedPreviewHost,
  previewMatchesHead,
  previewUrlFromChecks,
  previewUrlFromComments,
} from "./prs-get";

/** A completed, successful CI run — the shape both providers map into. */
const run = (
  over: Partial<{
    name: string;
    summary: string | null;
    url: string | null;
    conclusion: string | null;
    state: string;
  }> = {},
) =>
  ({
    id: "1",
    name: "build",
    state: "completed" as const,
    conclusion: "success" as const,
    url: null,
    durationMs: null,
    summary: null,
    ...over,
  }) as Parameters<typeof previewUrlFromChecks>[0][number];

describe("previewUrlFromChecks", () => {
  /**
   * Real Workers Builds run (deco-sites/demo-storefront#93) — the bot's
   * comment for this Worker carries NO preview link, only the run's own
   * report does.
   */
  const workersRun = run({
    name: "Workers Builds: demo-storefront",
    summary:
      "\nBuild ID: [85b63568-6bf1-45d6-9d3b-57a558dee041](https://dash.cloudflare.com/x)\n" +
      "Script: [demo-storefront](https://dash.cloudflare.com/y)\n" +
      "Version ID: 1fe1ee18-b8d0-46ea-bdf1-45cef0cd6e4d\n",
  });

  it("derives the version preview url from the Workers Builds report", () => {
    expect(previewUrlFromChecks([workersRun])).toBe(
      "https://1fe1ee18-demo-storefront.deco-cx.workers.dev",
    );
  });

  it("ignores runs that are not Workers Builds, or have no version yet", () => {
    expect(
      previewUrlFromChecks([
        run({
          name: "cubic · AI code reviewer",
          summary: "Version ID: deadbeef-1",
        }),
        run({
          name: "Workers Builds: demo-storefront",
          summary: "Build queued",
        }),
        run({ name: "Workers Builds: demo-storefront" }),
      ]),
    ).toBeNull();
    expect(previewUrlFromChecks([])).toBeNull();
  });

  it("rejects a worker name that would forge a host outside workers.dev", () => {
    expect(
      previewUrlFromChecks([
        run({
          name: "Workers Builds: evil.example.com/x",
          summary: "Version ID: 1fe1ee18-b8d0",
        }),
      ]),
    ).toBeNull();
  });

  /**
   * The other shape: the run just LINKS the deploy. This is where a legacy
   * commit status's target URL now arrives — both providers map a status and a
   * check run into the same thing, which is what collapsed two separate reads
   * into one.
   */
  it("lifts a trusted preview URL a run links to", () => {
    expect(
      previewUrlFromChecks([
        run({ name: "ci", url: "https://github.com/acme/site/runs/1" }),
        run({ name: "deploy", url: "https://envs-x--a1b2.decocdn.com" }),
      ]),
    ).toBe("https://envs-x--a1b2.decocdn.com");
  });

  it("prefers a succeeded run's link over an in-flight one", () => {
    expect(
      previewUrlFromChecks([
        run({
          name: "deploy",
          state: "running",
          conclusion: null,
          url: "https://pending--a1b2.decocdn.com",
        }),
        run({ name: "deploy", url: "https://ready--c3d4.decocdn.com" }),
      ]),
    ).toBe("https://ready--c3d4.decocdn.com");
  });

  it("is null when no run points at a trusted preview host", () => {
    expect(
      previewUrlFromChecks([
        run({ name: "ci", url: "https://evil.example.com/?x=.decocdn.com" }),
      ]),
    ).toBeNull();
  });
});

describe("previewUrlFromComments", () => {
  /**
   * Real Cloudflare Workers bot comment (trimmed): both a commit and a branch
   * preview — the branch one is what stays valid as the branch gets commits.
   */
  const cloudflareBody =
    "## Deploying with Cloudflare Workers\n| Status | Preview URL |\n| - | - |\n" +
    "| ✅ | <a href='https://1799fcb3-decocms-tanstack.deco-cx.workers.dev'>Commit Preview URL</a>" +
    "<br><br><a href='https://fix-home-title-agents-247-1785513527-decocms-tanstack.deco-cx.workers.dev'>Branch Preview URL</a> |";
  const decobotBody =
    "**deco Deployment** · commit `1059e10`\n\n| Name | Preview |\n| - | - |\n" +
    "| example | [Visit Preview](https://envs-example--a1b2c3.decocdn.com) |";
  const vercelBody =
    "| Project | Deployment | Actions | Updated (UTC) |\n| :--- | :----- | :------ | :------ |\n" +
    "| [electrolux](https://vercel.com/deco13/electrolux) | [Ready](https://vercel.com/deco13/electrolux/GoTyhNUVcQSf7yKLG2yFtWjJ4sZA) | " +
    "[Preview](https://electrolux-git-fix-pdp-focus-order-mobile-menu-deco13.vercel.app) | Aug 6, 2026 10:47pm |";

  it("prefers the Cloudflare Branch Preview URL over the commit one", () => {
    expect(previewUrlFromComments([{ body: cloudflareBody }])).toBe(
      "https://fix-home-title-agents-247-1785513527-decocms-tanstack.deco-cx.workers.dev",
    );
  });

  it("lifts the deco.cx 'Visit Preview' markdown link", () => {
    expect(previewUrlFromComments([{ body: decobotBody }])).toBe(
      "https://envs-example--a1b2c3.decocdn.com",
    );
  });

  it("lifts the Vercel bot's Preview link", () => {
    expect(previewUrlFromComments([{ body: vercelBody }])).toBe(
      "https://electrolux-git-fix-pdp-focus-order-mobile-menu-deco13.vercel.app",
    );
  });

  it("is null with no preview comment", () => {
    expect(previewUrlFromComments([])).toBeNull();
    expect(previewUrlFromComments([{ body: "LGTM, nice work!" }])).toBeNull();
  });

  it("prefers the newest comment, so a stale re-deploy comment doesn't win", () => {
    expect(
      previewUrlFromComments([
        {
          body: "[Preview](https://electrolux-git-old-stale-deploy-deco13.vercel.app)",
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-01T00:00:00Z",
        },
        {
          body: vercelBody,
          createdAt: "2026-08-06T22:32:55Z",
          updatedAt: "2026-08-06T22:32:55Z",
        },
      ]),
    ).toBe(
      "https://electrolux-git-fix-pdp-focus-order-mobile-menu-deco13.vercel.app",
    );
  });

  /**
   * Vercel and Cloudflare edit ONE sticky comment on each push, so
   * `createdAt` stays frozen at the first post and only `updatedAt` moves. A
   * human comment posted in between (with a coincidentally matching host)
   * must not outrank the bot's freshly edited one.
   */
  it("ranks by updatedAt, so a sticky comment beats a later unrelated one", () => {
    expect(
      previewUrlFromComments([
        {
          body: vercelBody,
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-06T22:32:55Z",
        },
        {
          body: "unrelated note, see https://some-other.vercel.app",
          createdAt: "2026-08-03T00:00:00Z",
          updatedAt: "2026-08-03T00:00:00Z",
        },
      ]),
    ).toBe(
      "https://electrolux-git-fix-pdp-focus-order-mobile-menu-deco13.vercel.app",
    );
  });

  it("falls back to array order when no timestamp is usable", () => {
    expect(
      previewUrlFromComments([{ body: decobotBody }, { body: vercelBody }]),
    ).toBe("https://envs-example--a1b2c3.decocdn.com");
  });
});

describe("asHeadSha", () => {
  it("accepts a 7-to-40 char hex sha", () => {
    expect(asHeadSha("1059e10")).toBe("1059e10");
    expect(asHeadSha("a".repeat(40))).toBe("a".repeat(40));
  });

  /** Also what keeps a malformed value out of the deployment lookup. */
  it("rejects anything else", () => {
    expect(asHeadSha("main")).toBeNull();
    expect(asHeadSha("12345")).toBeNull();
    expect(asHeadSha("a".repeat(41))).toBeNull();
    expect(asHeadSha(undefined)).toBeNull();
    expect(asHeadSha(123)).toBeNull();
  });
});

describe("cardLifecycle", () => {
  /**
   * `merged` alone cannot answer whether the work landed: a closed-unmerged
   * change request and an open one both report false, and only the first is
   * settled. So the card keeps both fields, derived from the one state.
   */
  it("splits the three provider states into the card's two fields", () => {
    expect(cardLifecycle("open")).toEqual({ state: "open", merged: false });
    expect(cardLifecycle("closed")).toEqual({
      state: "closed",
      merged: false,
    });
    expect(cardLifecycle("merged")).toEqual({ state: "closed", merged: true });
  });
});

describe("isTrustedPreviewHost", () => {
  it("accepts the real deco preview hosts", () => {
    expect(
      isTrustedPreviewHost("https://envs-example--a1b2c3.decocdn.com/"),
    ).toBe(true);
    expect(
      isTrustedPreviewHost(
        "https://fix-home-247-decocms-tanstack.deco-cx.workers.dev/",
      ),
    ).toBe(true);
    expect(isTrustedPreviewHost("https://acme.deco.site/")).toBe(true);
    expect(isTrustedPreviewHost("https://deco.site")).toBe(true);
  });

  it("accepts Vercel preview subdomains but not the bare apex", () => {
    expect(
      isTrustedPreviewHost(
        "https://electrolux-git-fix-pdp-focus-order-mobile-menu-deco13.vercel.app",
      ),
    ).toBe(true);
    expect(isTrustedPreviewHost("https://vercel.app/")).toBe(false);
    expect(isTrustedPreviewHost("https://vercel.app.evil.com/")).toBe(false);
    expect(isTrustedPreviewHost("https://evilvercel.app/")).toBe(false);
  });

  it("accepts any vtex.app subdomain, not just *.preview.vtex.app", () => {
    expect(isTrustedPreviewHost("https://acme.preview.vtex.app/")).toBe(true);
    // FastStore WebOps publishes some deploys (e.g. a `staging` environment)
    // straight on `<account>.vtex.app`; the narrower rule dropped those.
    expect(isTrustedPreviewHost("https://acme.vtex.app/")).toBe(true);
    expect(isTrustedPreviewHost("https://preview.vtex.app.evil.com/")).toBe(
      false,
    );
  });

  it("rejects a decoy where the deco host is only in the path/query (injection)", () => {
    expect(
      isTrustedPreviewHost("https://evil.example.com/login?x=.decocdn.com"),
    ).toBe(false);
    expect(isTrustedPreviewHost("https://decocdn.com.evil.com/")).toBe(false);
    expect(isTrustedPreviewHost("https://not-deco.site.evil.com/")).toBe(false);
    expect(isTrustedPreviewHost("not a url")).toBe(false);
  });
});

describe("isRateLimitError", () => {
  // These are the exact strings the GitHub MCP surfaced in prod while the board
  // hammered it; retrying any of them is what kept the limit shut.
  it.each([
    "Streamable HTTP error: Error POSTing to endpoint: too many requests",
    "API rate limit exceeded for installation",
    "You have exceeded a secondary rate limit",
    "request failed with status 429",
  ])("treats %p as non-retriable", (message) => {
    expect(isRateLimitError(new Error(message))).toBe(true);
  });

  it("lets a genuine transient failure through to the retry", () => {
    expect(isRateLimitError(new Error("socket hang up"))).toBe(false);
    expect(isRateLimitError(new Error("Not Found"))).toBe(false);
  });

  it("handles a non-Error rejection", () => {
    expect(isRateLimitError("too many requests")).toBe(true);
    expect(isRateLimitError(null)).toBe(false);
  });

  // A bare 429 in the PR URL path (`…/pulls/429/merge`) is not the HTTP status.
  it("does not treat a 429 inside the request URL as a rate limit", () => {
    expect(
      isRateLimitError(
        new Error(
          "failed to merge pull request: PUT https://api.github.com/repos/o/r/pulls/429/merge: 405 Merge commits are not allowed on this repository. []",
        ),
      ),
    ).toBe(false);
  });

  // A real 429 status follows the URL after a space, so it survives the scrub.
  it("still catches a real 429 status that follows a URL", () => {
    expect(
      isRateLimitError(
        new Error(
          "PUT https://api.github.com/repos/o/r/pulls/71/merge: 429 Too Many Requests",
        ),
      ),
    ).toBe(true);
  });
  /** A provider client says so outright, so no phrase matching is needed. */
  it("recognises a typed provider rate-limit refusal", () => {
    expect(
      isRateLimitError(
        new GitProviderError({
          provider: "gitlab",
          status: 429,
          message: "GitLab API 429: Retry later",
        }),
      ),
    ).toBe(true);
    expect(
      isRateLimitError(
        new GitProviderError({
          provider: "gitlab",
          status: 404,
          message: "GitLab API 404: Not Found",
        }),
      ),
    ).toBe(false);
  });
});

describe("previewMatchesHead", () => {
  const pr = (checksStatus: "passing" | "failing" | "pending" | null) => ({
    state: "open",
    merged: false,
    checksStatus,
  });

  it("trusts a preview whose head checks are green", () => {
    expect(previewMatchesHead([pr("passing")])).toBe(true);
  });

  it("does NOT trust it while head's checks are red or still running", () => {
    // The incident: the deploy failed, so the per-PR preview URL kept serving
    // the last build that succeeded — with a 200, and last night's code.
    expect(previewMatchesHead([pr("failing")])).toBe(false);
    expect(previewMatchesHead([pr("pending")])).toBe(false);
  });

  it("trusts an unknown — no CI, or GitHub unreadable, must not freeze QA", () => {
    expect(previewMatchesHead([pr(null)])).toBe(true);
  });

  it("ignores PRs no reviewer would be dispatched at", () => {
    const closed = {
      state: "closed",
      merged: false,
      checksStatus: "failing" as const,
    };
    const merged = {
      state: "open",
      merged: true,
      checksStatus: "failing" as const,
    };
    expect(previewMatchesHead([closed, merged, pr("passing")])).toBe(true);
    expect(previewMatchesHead([])).toBe(true);
  });
});
