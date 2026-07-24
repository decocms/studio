/**
 * Authenticated Report Routes — `/api/_reports/*`
 *
 * Session-gated proxy between the report page (`/report/:domain`) and the
 * reports engine (reports.decocms.com, `/api/v2`). The engine's master API key
 * stays server-side; the caller's session email is the only delivery
 * address accepted when a scan starts.
 */

import { Hono } from "hono";
import { auth } from "@/auth";
import { resolveApiKey, resolveBaseUrl } from "@/tools/reports/auth-client";
import {
  type DomainSuggestion,
  type PublicReportResponse,
  type ReportState,
  type ResolvedLinkToken,
  type ScanStatus,
  type ScanTrigger,
  toDeck,
} from "@decocms/shared/reports/to-deck";

function engineFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${resolveBaseUrl({})}${path}`, init);
}

/**
 * Read an already-scanned domain's deck after the route's session gate.
 */
async function fetchReport(
  domain: string,
  // Reviewer preview: the approval password unlocks a pre-publish read —
  // forwarded as ?pw=, the engine bypasses ONLY its publish gate and returns
  // exactly what the public will see once approved.
  key?: string,
  // Viewer locale, forwarded as ?lang= so the engine renders that language.
  lang?: string,
): Promise<ReportState> {
  const params = new URLSearchParams();
  if (key) params.set("pw", key);
  if (lang) params.set("lang", lang);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await engineFetch(
    `/api/v2/public/diagnostics/${encodeURIComponent(domain)}${qs}`,
    { headers: { Accept: "application/json" } },
  );
  if (res.status === 404)
    return { status: "not_found", deck: null, scanned_at: null, drops: [] };
  if (!res.ok) throw new Error(`report read HTTP ${res.status}`);
  const resp = (await res.json()) as PublicReportResponse;
  const { deck, drops } = toDeck(resp);
  return {
    status: deck.slides.length ? "ready" : "empty",
    deck,
    scanned_at: resp.scanned_at,
    drops,
  };
}

const TERMINAL = new Set(["complete", "errored", "terminated", "unknown"]);

type ReportsEnv = {
  Variables: {
    reportUser: { email: string };
  };
};

const app = new Hono<ReportsEnv>();

app.use("*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user?.id) {
    return c.json({ error: "Authentication required" }, 401, {
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    });
  }

  c.set("reportUser", {
    email: session.user.email,
  });
  await next();
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie");
  return undefined;
});

/** GET /api/_reports/site/:domain — the deck for an already-scanned domain. */
app.get("/site/:domain", async (c) => {
  const domain = c.req.param("domain").trim();
  if (!domain) return c.json({ error: "domain is required" }, 400);
  const key = c.req.query("key")?.trim() || undefined;
  const lang = c.req.query("lang")?.trim() || undefined;
  try {
    const state = await fetchReport(domain, key, lang);
    // Never cached: the deck carries short-lived signed screenshot URLs.
    c.header("Cache-Control", "private, no-store");
    return c.json(state);
  } catch {
    return c.json({ error: "report read failed" }, 502);
  }
});

/** POST /api/_reports/run — trigger a scan (master-key, server-only). The
 *  engine is idempotent + single-flight, so spamming this for a domain never
 *  starts parallel runs. The engine receives the authenticated session email
 *  to notify the requester; it never accepts a caller-supplied address. The
 *  optional `distinctId` is the visitor's PostHog id, so the engine's
 *  server-side funnel events attribute to the same person. */
app.post("/run", async (c) => {
  let body: { domain?: unknown; distinctId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  const domain = typeof body.domain === "string" ? body.domain.trim() : "";
  if (!domain) return c.json({ error: "domain is required" }, 400);
  const email = c.get("reportUser").email;
  const distinctId =
    typeof body.distinctId === "string" &&
    body.distinctId.trim() &&
    body.distinctId.length <= 200
      ? body.distinctId.trim()
      : undefined;

  try {
    const res = await engineFetch(`/api/v2/diagnostics/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolveApiKey({})}`,
      },
      body: JSON.stringify({ url: domain, email, distinct_id: distinctId }),
    });
    if (!res.ok) return c.json({ error: `run HTTP ${res.status}` }, 502);
    const j = (await res.json()) as {
      id?: string;
      status?: string;
      blocked?: boolean;
      mode?: string;
    };
    const trigger: ScanTrigger = j.blocked
      ? { state: "blocked" }
      : j.status === "fresh"
        ? { state: "fresh" }
        : j.mode === "sync"
          ? { state: "sync" }
          : { state: "running", id: j.id ?? null };
    return c.json(trigger);
  } catch {
    return c.json({ error: "run failed" }, 502);
  }
});

/** GET /api/_reports/status?id= — poll a durable run (master-key, server-only). */
app.get("/status", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id is required" }, 400);
  try {
    const res = await engineFetch(
      `/api/v2/diagnostics/status?id=${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${resolveApiKey({})}` } },
    );
    if (!res.ok) return c.json({ error: `status HTTP ${res.status}` }, 502);
    const j = (await res.json()) as { status?: string };
    const status = j.status ?? "unknown";
    const scan: ScanStatus = { done: TERMINAL.has(status), status };
    return c.json(scan);
  } catch {
    return c.json({ error: "status failed" }, 502);
  }
});

/** GET /api/_reports/link-token/:id — resolve an email link's `d` token to the
 *  {domain, run_id} it was minted for. Session auth is still required even
 *  though the engine token itself is unguessable. Null on a 404. */
app.get("/link-token/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const res = await engineFetch(
      `/api/v2/public/link-tokens/${encodeURIComponent(id)}`,
      { headers: { Accept: "application/json" } },
    );
    if (res.status === 404) return c.json(null);
    if (!res.ok) return c.json({ error: `link token HTTP ${res.status}` }, 502);
    return c.json((await res.json()) as ResolvedLinkToken);
  } catch {
    return c.json({ error: "link token resolve failed" }, 502);
  }
});

/** GET /api/_reports/suggest?q= — typo-tolerant domain suggestions for the URL
 *  input. Fail-soft: suggestions are a hint, never worth surfacing an error. */
app.get("/suggest", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 64);
  if (q.length < 2) return c.json({ suggestions: [] });
  try {
    const res = await engineFetch(
      `/api/v2/public/suggest?q=${encodeURIComponent(q)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return c.json({ suggestions: [] });
    const j = (await res.json()) as { suggestions?: DomainSuggestion[] };
    return c.json({
      suggestions: Array.isArray(j.suggestions) ? j.suggestions : [],
    });
  } catch {
    return c.json({ suggestions: [] });
  }
});

export default app;
