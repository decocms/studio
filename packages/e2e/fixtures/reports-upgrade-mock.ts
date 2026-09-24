/**
 * Standalone mock of the commerce-skills internal upgrade API.
 *
 * Launched as a Playwright `webServer` so the studio server can complete
 * `REPORTS_SETUP` end-to-end without reaching the real production
 * reports service (https://reports.decocms.com). The studio server is
 * pointed here via `REPORTS_INTERNAL_API_URL` in the Playwright
 * config.
 *
 * Black-box: the studio server reaches this over HTTP only — no app imports.
 * Uses `node:http` (NOT `Bun.serve`) so it typechecks under the suite's Node
 * types and runs under either node or bun.
 *
 * Mirrors the real contract from `api/v2/internal/diagnostics/:domain/*`:
 *   POST /upgrade { org_id, name } -> { url, org_id, scope, token, run }
 *   POST /run     { org_id }       -> { url, scope, run }   (triggered on
 *                                      "See full report"; the flow awaits it)
 * It also captures the public report scan contract used by report specs:
 *   POST /api/v2/diagnostics/run { url, email, distinct_id }
 * and serves one published report (`published.example`) as the one-pager:
 *   GET /api/v2/public/diagnostics/published.example/onepager{,.md}
 * And exposes an empty OpenAI-compatible model catalog for UI specs that need
 * a configured provider without calling a real model vendor:
 *   GET /v1/models -> { data: [] }
 */

import { createServer } from "node:http";

const port = Number(process.env.COMMERCE_MOCK_PORT ?? "4100");
const UPGRADE_RE = /^\/api\/v2\/internal\/diagnostics\/([^/]+)\/upgrade$/;
const RUN_RE = /^\/api\/v2\/internal\/diagnostics\/([^/]+)\/run$/;
const PUBLIC_REPORT_RUN_PATH = "/api/v2/diagnostics/run";
const CAPTURED_REPORT_RUN_PATH = "/__e2e/report-run";
const capturedReportRuns = new Map<string, Record<string, unknown>>();
const PUBLISHED_ONEPAGER_PATH =
  "/api/v2/public/diagnostics/published.example/onepager";
const PUBLISHED_ONEPAGER = {
  domain: "published.example",
  brand: "Published Example",
  scanned_at: "2026-09-20T12:00:00.000Z",
  lang: "en",
  score: 62,
  band: "Fair",
  totals: { measured: 3, registry_total: 5, passed: 1, failed: 2, blocked: 1 },
  buckets: [
    {
      id: "critical",
      label: "Critical",
      items: [
        {
          check_id: "PERF-001",
          title: "LCP within target",
          category: "Performance",
          severity: "error",
          controllability: "Deco-controllable",
          pages: ["Home"],
          tasks: ["Preload the hero image"],
          evidence: "LCP 4.1s on the home page",
          sources: [],
        },
      ],
    },
    {
      id: "important",
      label: "Important",
      items: [
        {
          check_id: "SEC-002",
          title: "HSTS enabled",
          category: "Security",
          severity: "warning",
          controllability: "External",
          pages: [],
          tasks: [],
          evidence: "No Strict-Transport-Security header",
          sources: [],
        },
      ],
    },
    { id: "worth", label: "Worth doing", items: [] },
  ],
  passing: { count: 1, items: [{ check_id: "SEO-001", title: "Has a title" }] },
  not_measured: {
    count: 1,
    groups: [
      {
        reason: "tool-auth",
        label: "Waiting for a data connection",
        count: 1,
        checks: ["Revenue per session"],
      },
    ],
  },
  categories: [],
  screenshots: [],
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
    return;
  }

  if (req.method === "GET" && url.pathname === PUBLISHED_ONEPAGER_PATH) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(PUBLISHED_ONEPAGER));
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === `${PUBLISHED_ONEPAGER_PATH}.md`
  ) {
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
    res.end("# Published Example — diagnostic\n\n### ✗ LCP within target\n");
    return;
  }

  if (req.method === "GET" && url.pathname === CAPTURED_REPORT_RUN_PATH) {
    const domain = url.searchParams.get("domain") ?? "";
    const captured = capturedReportRuns.get(domain);
    res.writeHead(captured ? 200 : 404, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify(captured ?? { error: "not found" }));
    return;
  }

  if (req.method === "POST" && url.pathname === PUBLIC_REPORT_RUN_PATH) {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw || "{}") as Record<string, unknown>;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON" }));
        return;
      }
      const domain = typeof body.url === "string" ? body.url : "";
      if (!domain) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "url is required" }));
        return;
      }
      capturedReportRuns.set(domain, body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "fresh" }));
    });
    return;
  }

  const match = url.pathname.match(UPGRADE_RE);
  if (req.method === "POST" && match) {
    const domain = decodeURIComponent(match[1]);
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let orgId: string | null = null;
      try {
        orgId = (JSON.parse(raw || "{}") as { org_id?: string }).org_id ?? null;
      } catch {
        orgId = null;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          url: domain,
          org_id: orgId,
          scope: "private",
          token: `dgn_e2e_${orgId ?? "unknown"}`,
          run: { id: "run_e2e", status: "running" },
        }),
      );
    });
    return;
  }

  const runMatch = url.pathname.match(RUN_RE);
  if (req.method === "POST" && runMatch) {
    const domain = decodeURIComponent(runMatch[1]);
    req.on("data", () => {}); // drain
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          url: domain,
          scope: "private",
          run: { id: "run_e2e", status: "running" },
        }),
      );
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, () => {
  console.log(`[commerce-upgrade-mock] listening on http://localhost:${port}`);
});
