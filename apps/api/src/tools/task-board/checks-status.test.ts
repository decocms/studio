/**
 * Pure mapping from a GitHub combined-status response to the three-value
 * `checksStatus` the board renders. No I/O — the live fetch and its failure
 * modes belong to e2e; this pins only the state translation.
 */
import { describe, expect, it } from "bun:test";
import {
  conflictFromPrGet,
  extractPreviewUrl,
  extractPreviewUrlFromComments,
  isDecoPreviewHost,
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

describe("isDecoPreviewHost", () => {
  it("accepts the real deco preview hosts", () => {
    expect(
      isDecoPreviewHost("https://envs-montecarlo--c8xgrn.decocdn.com/"),
    ).toBe(true);
    expect(
      isDecoPreviewHost(
        "https://fix-home-247-decocms-tanstack.deco-cx.workers.dev/",
      ),
    ).toBe(true);
    expect(isDecoPreviewHost("https://acme.deco.site/")).toBe(true);
    expect(isDecoPreviewHost("https://deco.site")).toBe(true);
  });

  it("rejects a decoy where the deco host is only in the path/query (injection)", () => {
    expect(
      isDecoPreviewHost("https://evil.example.com/login?x=.decocdn.com"),
    ).toBe(false);
    expect(isDecoPreviewHost("https://decocdn.com.evil.com/")).toBe(false);
    expect(isDecoPreviewHost("https://not-deco.site.evil.com/")).toBe(false);
    expect(isDecoPreviewHost("not a url")).toBe(false);
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
});
