/**
 * Pure mapping from a GitHub combined-status response to the three-value
 * `checksStatus` the board renders. No I/O — the live fetch and its failure
 * modes belong to e2e; this pins only the state translation.
 */
import { describe, expect, it } from "bun:test";
import {
  conflictFromPrGet,
  extractPreviewUrl,
  extractPreviewUrlFromDeployment,
  headShaFromPrGet,
  headShaFromStatus,
  isRateLimitError,
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
            target_url: "https://envs-montecarlo--c8xgrn.decocdn.com/",
          },
        ],
      }),
    ).toBe("https://envs-montecarlo--c8xgrn.decocdn.com/");

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
  it("maps GitHub Actions check-runs (montecarlo's failing 'Deco / QA' run)", () => {
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
    // montecarlo: empty combined status (null) + failing check-run → failing.
    expect(
      mergeChecksStatus(toChecksStatus({ total_count: 0 }), "failing"),
    ).toBe("failing");
  });
});

describe("isTrustedPreviewHost", () => {
  it("accepts the real deco preview hosts", () => {
    expect(
      isTrustedPreviewHost("https://envs-montecarlo--c8xgrn.decocdn.com/"),
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

  it("accepts VTEX preview subdomains but not other vtex.app hosts", () => {
    expect(isTrustedPreviewHost("https://acme.preview.vtex.app/")).toBe(true);
    expect(isTrustedPreviewHost("https://acme.vtex.app/")).toBe(false);
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
    "| montecarlo | [Visit Preview](https://envs-montecarlo--c8xgrn.decocdn.com) |";
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
      "https://envs-montecarlo--c8xgrn.decocdn.com",
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
    ).toBe("https://envs-montecarlo--c8xgrn.decocdn.com");
    expect(
      extractPreviewUrlFromComments({ items: [{ body: decobotBody }] }),
    ).toBe("https://envs-montecarlo--c8xgrn.decocdn.com");
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
    ).toBe("https://envs-montecarlo--c8xgrn.decocdn.com");
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
});
