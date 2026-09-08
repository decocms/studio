/**
 * Pure mapping from a GitHub combined-status response to the three-value
 * `checksStatus` the board renders. No I/O — the live fetch and its failure
 * modes belong to e2e; this pins only the state translation.
 */
import { isCardNotReady } from "@decocms/shared/task-board";
import { describe, expect, it } from "bun:test";
import {
  checksFromMergeableState,
  conflictFromPrGet,
  previewMatchesHead,
  extractPreviewUrl,
  extractPreviewUrlFromDeployment,
  headShaFromPrGet,
  headShaFromStatus,
  isRateLimitError,
  extractPreviewUrlFromCheckRuns,
  extractPreviewUrlFromComments,
  isTrustedPreviewHost,
  mergeChecksStatus,
  parseCheckRuns,
  toCheckRunsStatus,
  toChecksStatus,
} from "./prs-get";

describe("toChecksStatus", () => {
  it("maps success → passing", () => {
    expect(toChecksStatus({ state: "success", total_count: 3 })).toBe(
      "passing",
    );
  });

  it("maps failure and error → failing", () => {
    expect(toChecksStatus({ state: "failure", total_count: 2 })).toBe(
      "failing",
    );
    expect(toChecksStatus({ state: "error", total_count: 1 })).toBe("failing");
  });

  it("maps pending → pending", () => {
    expect(toChecksStatus({ state: "pending", total_count: 1 })).toBe(
      "pending",
    );
  });

  it("treats a PR with no checks (total_count 0) as null, not pending", () => {
    expect(toChecksStatus({ state: "pending", total_count: 0 })).toBeNull();
  });

  it("is null for a missing response or unknown state", () => {
    expect(toChecksStatus(null)).toBeNull();
    expect(toChecksStatus({ state: "weird", total_count: 1 })).toBeNull();
  });
});

describe("conflictFromPrGet", () => {
  it("maps an open PR with mergeable === false → conflict (true)", () => {
    expect(conflictFromPrGet({ state: "open", mergeable: false })).toBe(true);
  });

  it("maps an open, mergeable PR → false", () => {
    expect(conflictFromPrGet({ state: "open", mergeable: true })).toBe(false);
  });

  it("is null when GitHub hasn't computed mergeability yet (mergeable null/absent)", () => {
    // GitHub computes `mergeable` asynchronously — it's null right after a push.
    // An unknown must NEVER read as a conflict (the caller only acts on `true`).
    expect(conflictFromPrGet({ state: "open", mergeable: null })).toBeNull();
    expect(conflictFromPrGet({ state: "open" })).toBeNull();
  });

  it("treats a non-open PR as not-conflicting, never a conflict", () => {
    // A merged/closed PR reports `mergeable: null` but must not read as a
    // conflict (guards a just-merged PR from a spurious resolution run).
    expect(conflictFromPrGet({ state: "closed", mergeable: null })).toBe(false);
    expect(conflictFromPrGet({ state: "merged", mergeable: false })).toBe(
      false,
    );
  });

  it("is null for a missing response", () => {
    expect(conflictFromPrGet(null)).toBeNull();
  });

  it("reads mergeable_state — github-mcp's MinimalPullRequest has no `mergeable`", () => {
    expect(conflictFromPrGet({ state: "open", mergeable_state: "dirty" })).toBe(
      true,
    );
    expect(conflictFromPrGet({ state: "open", mergeable_state: "clean" })).toBe(
      false,
    );
    expect(
      conflictFromPrGet({ state: "open", mergeable_state: "blocked" }),
    ).toBe(false);
  });

  it("is null when mergeable_state is unknown or empty — still computing", () => {
    expect(
      conflictFromPrGet({ state: "open", mergeable_state: "unknown" }),
    ).toBeNull();
    expect(
      conflictFromPrGet({ state: "open", mergeable_state: "" }),
    ).toBeNull();
  });

  it("prefers the boolean when a non-minimal response carries both", () => {
    expect(
      conflictFromPrGet({
        state: "open",
        mergeable: true,
        mergeable_state: "dirty",
      }),
    ).toBe(false);
  });
});

describe("extractPreviewUrl", () => {
  it("lifts a deco preview URL from a status target_url (Deno + Tanstack hosts)", () => {
    expect(
      extractPreviewUrl({
        statuses: [
          {
            context: "ci/lint",
            state: "success",
            target_url: "https://ci.example.com/1",
          },
          {
            context: "deco/preview",
            state: "success",
            target_url: "https://envs-example--a1b2c3.decocdn.com/",
          },
        ],
      }),
    ).toBe("https://envs-example--a1b2c3.decocdn.com/");

    expect(
      extractPreviewUrl({
        statuses: [
          {
            state: "success",
            target_url:
              "https://fix-home-title-agents-247-1785513527-decocms-tanstack.deco-cx.workers.dev/",
          },
        ],
      }),
    ).toBe(
      "https://fix-home-title-agents-247-1785513527-decocms-tanstack.deco-cx.workers.dev/",
    );
  });

  it("prefers a succeeded preview status over a pending one", () => {
    expect(
      extractPreviewUrl({
        statuses: [
          { state: "pending", target_url: "https://old--a.decocdn.com/" },
          { state: "success", target_url: "https://new--b.decocdn.com/" },
        ],
      }),
    ).toBe("https://new--b.decocdn.com/");
  });

  it("is null when no status points at a deco preview host", () => {
    expect(extractPreviewUrl(null)).toBeNull();
    expect(
      extractPreviewUrl({
        statuses: [
          { state: "success", target_url: "https://ci.example.com/x" },
        ],
      }),
    ).toBeNull();
    expect(extractPreviewUrl({})).toBeNull();
  });
});

describe("toCheckRunsStatus", () => {
  it("maps GitHub Actions check-runs (a real failing 'Deco / QA' run)", () => {
    expect(
      toCheckRunsStatus({
        check_runs: [
          {
            name: "Deco / QA / Purchase journey",
            status: "completed",
            conclusion: "failure",
          },
        ],
      }),
    ).toBe("failing");
  });

  it("is passing when all runs completed successfully (incl. neutral/skipped)", () => {
    expect(
      toCheckRunsStatus({
        check_runs: [
          { status: "completed", conclusion: "success" },
          { status: "completed", conclusion: "skipped" },
        ],
      }),
    ).toBe("passing");
  });

  it("is pending while any run is not completed", () => {
    expect(
      toCheckRunsStatus([
        { status: "completed", conclusion: "success" },
        { status: "in_progress", conclusion: null },
      ]),
    ).toBe("pending");
  });

  it("is null with no check-runs", () => {
    expect(toCheckRunsStatus({ check_runs: [] })).toBeNull();
    expect(toCheckRunsStatus(null)).toBeNull();
  });
});

describe("parseCheckRuns", () => {
  it("flattens a get_check_runs result to name/status/conclusion/detailsUrl", () => {
    expect(
      parseCheckRuns({
        check_runs: [
          {
            id: 42,
            name: "Deco / QA",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/x/y/runs/42",
          },
        ],
      }),
    ).toEqual([
      {
        id: 42,
        name: "Deco / QA",
        status: "completed",
        conclusion: "failure",
        detailsUrl: "https://github.com/x/y/runs/42",
      },
    ]);
  });

  it("accepts a raw array and tolerates missing fields", () => {
    expect(parseCheckRuns([{ name: "lint" }])).toEqual([
      {
        id: null,
        name: "lint",
        status: "completed",
        conclusion: null,
        detailsUrl: null,
      },
    ]);
    expect(parseCheckRuns(null)).toEqual([]);
  });
});

describe("mergeChecksStatus", () => {
  it("takes the worst of the two (failing > pending > passing > null)", () => {
    expect(mergeChecksStatus(null, "failing")).toBe("failing");
    expect(mergeChecksStatus("passing", "pending")).toBe("pending");
    expect(mergeChecksStatus("passing", null)).toBe("passing");
    expect(mergeChecksStatus(null, null)).toBeNull();
    // Seen in production: empty combined status (null) + failing check-run → failing.
    expect(
      mergeChecksStatus(toChecksStatus({ total_count: 0 }), "failing"),
    ).toBe("failing");
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

describe("extractPreviewUrlFromCheckRuns", () => {
  // Real Workers Builds check-run shape (deco-sites/demo-storefront#93) — the
  // bot's PR comment for this Worker carries NO preview link, only this does.
  const workersRun = {
    name: "Workers Builds: demo-storefront",
    output: {
      title: "Workers Builds: demo-storefront",
      summary:
        "\nBuild ID: [85b63568-6bf1-45d6-9d3b-57a558dee041](https://dash.cloudflare.com/x)\n" +
        "Script: [demo-storefront](https://dash.cloudflare.com/y)\n" +
        "Version ID: 1fe1ee18-b8d0-46ea-bdf1-45cef0cd6e4d\n",
    },
  };

  it("derives the version preview url from the Workers Builds summary", () => {
    expect(extractPreviewUrlFromCheckRuns({ check_runs: [workersRun] })).toBe(
      "https://1fe1ee18-demo-storefront.deco-cx.workers.dev",
    );
    expect(extractPreviewUrlFromCheckRuns([workersRun])).toBe(
      "https://1fe1ee18-demo-storefront.deco-cx.workers.dev",
    );
  });

  it("ignores runs that are not Workers Builds, or have no version yet", () => {
    expect(
      extractPreviewUrlFromCheckRuns([
        {
          name: "cubic · AI code reviewer",
          output: { summary: "Version ID: deadbeef-1" },
        },
        {
          name: "Workers Builds: demo-storefront",
          output: { summary: "Build queued" },
        },
        { name: "Workers Builds: demo-storefront" },
      ]),
    ).toBeNull();
    expect(extractPreviewUrlFromCheckRuns(null)).toBeNull();
    expect(extractPreviewUrlFromCheckRuns({})).toBeNull();
  });

  it("rejects a worker name that would forge a host outside workers.dev", () => {
    expect(
      extractPreviewUrlFromCheckRuns([
        {
          name: "Workers Builds: evil.example.com/x",
          output: { summary: "Version ID: 1fe1ee18-b8d0" },
        },
      ]),
    ).toBeNull();
  });
});

describe("extractPreviewUrlFromComments", () => {
  // Real Cloudflare Workers bot comment shape (trimmed): both a commit and a
  // branch preview — the branch one is what we want.
  const cloudflareBody =
    "## Deploying with Cloudflare Workers\n| Status | Preview URL |\n| - | - |\n" +
    "| ✅ | <a href='https://1799fcb3-decocms-tanstack.deco-cx.workers.dev'>Commit Preview URL</a>" +
    "<br><br><a href='https://fix-home-title-agents-247-1785513527-decocms-tanstack.deco-cx.workers.dev'>Branch Preview URL</a> |";
  // Real deco.cx `decobot` comment shape (trimmed).
  const decobotBody =
    "**deco Deployment** · commit `1059e10`\n\n| Name | Preview |\n| - | - |\n" +
    "| example | [Visit Preview](https://envs-example--a1b2c3.decocdn.com) |";
  // Real Vercel bot comment shape (trimmed, from deco-sites/electrolux#10).
  const vercelBody =
    "| Project | Deployment | Actions | Updated (UTC) |\n| :--- | :----- | :------ | :------ |\n" +
    "| [electrolux](https://vercel.com/deco13/electrolux) | ![Ready](https://vercel.com/static/status/ready.svg) [Ready](https://vercel.com/deco13/electrolux/GoTyhNUVcQSf7yKLG2yFtWjJ4sZA) | " +
    "[Preview](https://electrolux-git-fix-pdp-focus-order-mobile-menu-deco13.vercel.app) | Aug 6, 2026 10:47pm |";

  it("prefers the Cloudflare Branch Preview URL over the commit one", () => {
    expect(extractPreviewUrlFromComments([{ body: cloudflareBody }])).toBe(
      "https://fix-home-title-agents-247-1785513527-decocms-tanstack.deco-cx.workers.dev",
    );
  });

  it("lifts the deco.cx 'Visit Preview' markdown link", () => {
    expect(extractPreviewUrlFromComments([{ body: decobotBody }])).toBe(
      "https://envs-example--a1b2c3.decocdn.com",
    );
  });

  it("lifts the Vercel bot's Preview link", () => {
    expect(extractPreviewUrlFromComments([{ body: vercelBody }])).toBe(
      "https://electrolux-git-fix-pdp-focus-order-mobile-menu-deco13.vercel.app",
    );
  });

  it("accepts the { comments } and { items } wrapper shapes", () => {
    expect(
      extractPreviewUrlFromComments({ comments: [{ body: decobotBody }] }),
    ).toBe("https://envs-example--a1b2c3.decocdn.com");
    expect(
      extractPreviewUrlFromComments({ items: [{ body: decobotBody }] }),
    ).toBe("https://envs-example--a1b2c3.decocdn.com");
  });

  it("is null with no deco preview comment", () => {
    expect(extractPreviewUrlFromComments([])).toBeNull();
    expect(extractPreviewUrlFromComments(null)).toBeNull();
    expect(
      extractPreviewUrlFromComments([{ body: "LGTM, nice work!" }]),
    ).toBeNull();
  });

  it("prefers the newest comment by updated_at over array order, so a stale re-deploy comment doesn't win", () => {
    const staleVercelBody =
      "[Preview](https://electrolux-git-old-stale-deploy-deco13.vercel.app)";
    const fresh = extractPreviewUrlFromComments([
      {
        body: staleVercelBody,
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      },
      {
        body: vercelBody,
        created_at: "2026-08-06T22:32:55Z",
        updated_at: "2026-08-06T22:32:55Z",
      },
    ]);
    expect(fresh).toBe(
      "https://electrolux-git-fix-pdp-focus-order-mobile-menu-deco13.vercel.app",
    );
  });

  it("prefers a comment's updated_at over its created_at, so a sticky comment edited in place beats an unrelated later comment", () => {
    // Vercel/Cloudflare edit a single sticky comment on each push — created_at
    // stays frozen at the FIRST post, only updated_at moves forward. A human
    // comment posted in between (with a coincidentally-matching host) must
    // NOT outrank the bot's freshly-edited comment just because its
    // created_at is later.
    const stickyBotComment = {
      body: vercelBody,
      created_at: "2026-08-01T00:00:00Z", // first posted early in the PR
      updated_at: "2026-08-06T22:32:55Z", // edited in place on the latest push
    };
    const laterUnrelatedComment = {
      body: "unrelated review note, check https://some-other.vercel.app for reference",
      created_at: "2026-08-03T00:00:00Z", // posted after the bot's first post...
      updated_at: "2026-08-03T00:00:00Z", // ...but never edited again
    };
    expect(
      extractPreviewUrlFromComments([stickyBotComment, laterUnrelatedComment]),
    ).toBe(
      "https://electrolux-git-fix-pdp-focus-order-mobile-menu-deco13.vercel.app",
    );
  });

  it("falls back to created_at, then array order, when updated_at is missing", () => {
    expect(
      extractPreviewUrlFromComments([
        { body: decobotBody },
        { body: vercelBody },
      ]),
    ).toBe("https://envs-example--a1b2c3.decocdn.com");
  });
});

describe("extractPreviewUrlFromDeployment", () => {
  it("lifts a trusted environmentUrl from a GET_PREVIEW_DEPLOYMENT result", () => {
    expect(
      extractPreviewUrlFromDeployment({
        environmentUrl: "https://sfj-b212cf4--torrafaststore.preview.vtex.app",
        environment: "staging",
        state: "success",
        deploymentId: 42,
      }),
    ).toBe("https://sfj-b212cf4--torrafaststore.preview.vtex.app");
  });

  it("is null when no deployment has published a url yet (in-flight)", () => {
    expect(
      extractPreviewUrlFromDeployment({
        environmentUrl: null,
        environment: null,
        state: null,
        deploymentId: null,
      }),
    ).toBeNull();
    expect(extractPreviewUrlFromDeployment(null)).toBeNull();
    expect(extractPreviewUrlFromDeployment({})).toBeNull();
  });

  it("rejects an untrusted environmentUrl host", () => {
    expect(
      extractPreviewUrlFromDeployment({
        environmentUrl:
          "https://evil.example.com/torrafaststore.preview.vtex.app",
      }),
    ).toBeNull();
  });
});

describe("headShaFromPrGet", () => {
  it("reads head.sha from a pull_request_read get response", () => {
    expect(
      headShaFromPrGet({
        state: "open",
        head: { ref: "fix/x", sha: "f9f522ce9642cf7f2024e45b9ddc618a6f78bf8c" },
      }),
    ).toBe("f9f522ce9642cf7f2024e45b9ddc618a6f78bf8c");
  });

  it("is null when head/sha is absent or not a hex sha", () => {
    expect(headShaFromPrGet(null)).toBeNull();
    expect(headShaFromPrGet({})).toBeNull();
    expect(headShaFromPrGet({ head: {} })).toBeNull();
    expect(headShaFromPrGet({ head: { sha: 123 } })).toBeNull();
    expect(headShaFromPrGet({ head: { sha: "not-a-sha" } })).toBeNull();
    expect(headShaFromPrGet({ head: "nope" })).toBeNull();
  });
});

describe("headShaFromStatus", () => {
  it("reads the head sha from a combined-status response", () => {
    expect(
      headShaFromStatus({
        state: "success",
        sha: "f9f522ce9642cf7f2024e45b9ddc618a6f78bf8c",
        total_count: 1,
      }),
    ).toBe("f9f522ce9642cf7f2024e45b9ddc618a6f78bf8c");
  });

  it("is null when the sha is absent or not a hex sha", () => {
    expect(headShaFromStatus(null)).toBeNull();
    expect(headShaFromStatus({})).toBeNull();
    expect(headShaFromStatus({ sha: 123 })).toBeNull();
    expect(headShaFromStatus({ sha: "not-a-sha" })).toBeNull();
    expect(headShaFromStatus({ sha: "abc/../def" })).toBeNull();
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
});

describe("checksFromMergeableState", () => {
  it("maps the two unambiguous values", () => {
    expect(checksFromMergeableState("clean")).toBe("passing");
    expect(checksFromMergeableState("unstable")).toBe("failing");
  });

  it("is null for everything that says nothing about checks", () => {
    // `blocked` is the load-bearing one: it also covers a missing required
    // review, so reading it as red would hold QA on a healthy deploy.
    expect(checksFromMergeableState("blocked")).toBeNull();
    expect(checksFromMergeableState("dirty")).toBeNull();
    expect(checksFromMergeableState("behind")).toBeNull();
    expect(checksFromMergeableState("unknown")).toBeNull();
    expect(checksFromMergeableState(undefined)).toBeNull();
    expect(checksFromMergeableState(null)).toBeNull();
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

describe("isCardNotReady", () => {
  const NOW = Date.parse("2026-09-08T12:00:00Z");
  const recent = new Date(NOW - 60_000).toISOString();
  const old = new Date(NOW - 30 * 60_000).toISOString();
  const open = { state: "open" as string | null, updatedAt: recent };

  it("keeps refreshing while CI runs", () => {
    expect(
      isCardNotReady(
        { ...open, checksStatus: "pending", previewUrl: null },
        NOW,
      ),
    ).toBe(true);
    // Preview already found used to make this false — hence "Checks pending".
    expect(
      isCardNotReady(
        { ...open, checksStatus: "pending", previewUrl: "https://x.vtex.app" },
        NOW,
      ),
    ).toBe(true);
    // Pending CI ends by itself, so it isn't subject to the preview bound.
    expect(
      isCardNotReady(
        { ...open, updatedAt: old, checksStatus: "pending", previewUrl: null },
        NOW,
      ),
    ).toBe(true);
  });

  it("keeps refreshing after CI settles until a preview url is found", () => {
    // The deploy bot's comment lands AFTER the checks go green.
    expect(
      isCardNotReady(
        { ...open, checksStatus: "passing", previewUrl: null },
        NOW,
      ),
    ).toBe(true);
  });

  it("stops chasing a preview that never came", () => {
    // previewUrl stays null forever on a repo that publishes no preview.
    expect(
      isCardNotReady(
        { ...open, updatedAt: old, checksStatus: "passing", previewUrl: null },
        NOW,
      ),
    ).toBe(false);
    // Unknown activity time doesn't chase — safe direction for the rate limit.
    expect(
      isCardNotReady(
        { ...open, updatedAt: null, checksStatus: "passing", previewUrl: null },
        NOW,
      ),
    ).toBe(false);
  });

  it("caches normally once CI settled and a preview is known", () => {
    for (const checksStatus of ["passing", "failing"] as const) {
      expect(
        isCardNotReady(
          { ...open, checksStatus, previewUrl: "https://x.vtex.app" },
          NOW,
        ),
      ).toBe(false);
    }
  });

  it("never chases a PR GitHub reported as not open", () => {
    expect(
      isCardNotReady(
        {
          state: "closed",
          updatedAt: recent,
          checksStatus: null,
          previewUrl: null,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("always refreshes the placeholder, which GitHub was never asked about", () => {
    // Every live field is null on the card served before the first read; a
    // settled-looking `state: null` must not park it for the full hit window.
    expect(
      isCardNotReady(
        { state: null, updatedAt: null, checksStatus: null, previewUrl: null },
        NOW,
      ),
    ).toBe(true);
  });
});

describe("extractPreviewUrlFromCheckRuns — preview without a bot comment", () => {
  const run = (o: Record<string, unknown>) => ({ check_runs: [o] });

  it("reads the url out of a deploy check's output", () => {
    expect(
      extractPreviewUrlFromCheckRuns(
        run({
          name: "Cloudflare Pages",
          conclusion: "success",
          output: { summary: "Deployed to https://abc.deco.site 🎉" },
        }),
      ),
    ).toBe("https://abc.deco.site");
  });

  it("falls back to the details link", () => {
    expect(
      extractPreviewUrlFromCheckRuns(
        run({ name: "deploy", details_url: "https://x.vtex.app/" }),
      ),
    ).toBe("https://x.vtex.app/");
  });

  it("prefers a successful run over a failed earlier attempt", () => {
    expect(
      extractPreviewUrlFromCheckRuns({
        check_runs: [
          {
            name: "deploy",
            conclusion: "failure",
            details_url: "https://bad.deco.site",
          },
          {
            name: "deploy",
            conclusion: "success",
            details_url: "https://good.deco.site",
          },
        ],
      }),
    ).toBe("https://good.deco.site");
  });

  it("ignores a url that is not a trusted preview host", () => {
    expect(
      extractPreviewUrlFromCheckRuns(
        run({
          name: "lint",
          output: { summary: "see https://evil.example.com" },
        }),
      ),
    ).toBe(null);
  });

  it("still prefers the exact Workers Builds url over a scanned one", () => {
    expect(
      extractPreviewUrlFromCheckRuns({
        check_runs: [
          {
            name: "other",
            conclusion: "success",
            details_url: "https://x.vtex.app",
          },
          {
            name: "Workers Builds: my-site",
            output: { summary: "Version ID: abcd1234" },
          },
        ],
      }),
    ).toBe("https://abcd1234-my-site.deco-cx.workers.dev");
  });
});
