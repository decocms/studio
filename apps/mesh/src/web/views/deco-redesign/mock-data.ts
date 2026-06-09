// Mock data for the Deco redesign mockup (System Health capability).
// Pure data + types — no network, no MCP. This is the dev's contract:
// a "finding" IS a task, capabilities are subagents (never surfaced), and
// autonomy decides where a finding lands in the home.

export type Severity = "critical" | "warning" | "info";

/** How far Deco acts on a finding before a human. Shared, per-capability (see 04). */
export type AutonomyMode = "inform" | "propose" | "auto";

/** Which layer the issue lives in — the first thing Deco diagnoses. */
export type Layer = "cdn" | "origin" | "app" | "vtex";

// A finding's state answers ONE question: "what's my relationship to it now?"
// It is the lifecycle of the finding's *task* (needs_review → in_progress →
// resolved) plus two resting/terminal values that aren't lifecycle steps:
//  - `watching` — the resting state of an INFORM-autonomy finding (no task; FYI).
//  - `dismissed` vs `acknowledged` — two DIFFERENT terminal verbs:
//      dismissed   = "Deco, this wasn't real / too noisy" → negative memory signal.
//      acknowledged = "noted, thanks" → you cleared a watch, NO change shipped.
// `resolved` always means a change went live (you approved it, or auto shipped it).
export type IncidentState =
  | "needs_review" // propose & approve — waiting on you
  | "in_progress" // approved, Deco is shipping + watching
  | "resolved" // a change shipped (approved by you, or act & report)
  | "watching" // inform only — no action yet
  | "acknowledged" // you cleared a watch — seen, no change needed
  | "dismissed"; // you told Deco it wasn't real → tunes memory

export interface FixProposal {
  pr: number;
  title: string;
  summary: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  qa: "passed" | "running" | "failed";
  aiReview: "passed" | "flagged";
  diff: string;
}

export interface ThreadMessage {
  id: string;
  speaker: "deco" | "you";
  body: string;
}

/** What kicked off the task. Tasks run autonomously: a System Health (or
 *  content) trigger fires, delivering an event + signal as the run's input —
 *  the agent then investigates, notifies, and (per autonomy) proposes a fix.
 *  This replaces any "human asked" framing for proactive tasks. */
export interface Trigger {
  event: string; // e.g. "system_health.cdn_error"
  signal: string; // the payload that fired it
}

/** A finding == a task. The unit of everything. */
export interface Incident {
  id: string;
  title: string;
  /** A short clause for the home brief — lowercase, no trailing period, so it
   *  composes mid-sentence ("I caught {brief}."). */
  brief: string;
  /** The trigger event that started this task (autonomous run). */
  trigger: Trigger;
  severity: Severity;
  layer: Layer;
  state: IncidentState;
  autonomy: AutonomyMode;
  service: string;
  detectedAt: string;
  multiplier: string;
  errorsPerMin: number;
  impact: string;
  blurb: string;
  baseline: number;
  spike: number[];
  fix?: FixProposal;
  thread: ThreadMessage[];
}

/** The one teammate. Capabilities are subagents — the engine, never surfaced in nav. */
export interface DecoTeammate {
  name: string;
  storefront: string;
  capabilities: { id: string; label: string; status: "watching" | "paused" }[];
}

export const DECO: DecoTeammate = {
  name: "Deco",
  storefront: "Farm Rio",
  // Backstage only. Shown (if at all) as "what Deco runs", never as navigation.
  capabilities: [
    { id: "system-health", label: "System health", status: "watching" },
    { id: "seo", label: "SEO", status: "watching" },
    { id: "pagespeed", label: "Performance", status: "watching" },
    { id: "qa", label: "QA", status: "watching" },
    { id: "plp", label: "PLP optimizer", status: "paused" },
    { id: "pdp", label: "PDP optimizer", status: "paused" },
  ],
};

function ramp(base: number, peak: number, n = 24): number[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    // calm, then a sharp climb in the last third
    const climb = t < 0.62 ? 0 : (t - 0.62) / 0.38;
    const jitter = ((i * 7919) % 11) - 5; // deterministic wobble, no Math.random
    return Math.max(
      0,
      Math.round(base + (peak - base) * climb * climb + jitter),
    );
  });
}

function drop(high: number, low: number, n = 24): number[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const fall = t < 0.55 ? 0 : (t - 0.55) / 0.45;
    const jitter = ((i * 6131) % 9) - 4;
    return Math.max(0, Math.round(high - (high - low) * fall + jitter));
  });
}

export const INCIDENTS: Incident[] = [
  {
    id: "inc-500-vestidos",
    title: "500 spike on the dresses PLP",
    brief:
      "a 500 spike on the dresses collection page, about 4.4× normal, traced to yesterday's release",
    trigger: {
      event: "system_health.cdn_error",
      signal:
        "5xx on /novidades/vestidos crossed 4.4× the 24h baseline — ~2,300/min at peak.",
    },
    severity: "critical",
    layer: "origin",
    state: "needs_review",
    autonomy: "propose",
    service: "/novidades/vestidos",
    detectedAt: "Today, 03:14",
    multiplier: "4.4×",
    errorsPerMin: 2300,
    impact: "~R$12k/h at risk · top-3 mobile revenue page",
    blurb:
      "Error rate hit 4.4× baseline overnight. I traced it to the origin and drafted a fix.",
    baseline: 520,
    spike: ramp(520, 2300),
    fix: {
      pr: 3318,
      title: "Add a timeout and cached fallback to the dresses page loader",
      summary:
        "The dresses collection loader had no timeout against VTEX search — under load it hung and surfaced as edge 5xx. Adds a 2s timeout, 3× retry with backoff, and a fallback to the last good ordering.",
      filesChanged: 2,
      additions: 41,
      deletions: 6,
      qa: "passed",
      aiReview: "passed",
      diff: "+ const ordering = await withTimeout(vtex.search(query), 2000)\n+   .catch(() => lastGoodOrdering(collectionId));",
    },
    thread: [
      {
        id: "m1",
        speaker: "deco",
        body: "At 03:14 I saw 500s on /novidades/vestidos jump to 4.4× the 24h baseline — about 2,300 errors/min at peak. It's still elevated.",
      },
      {
        id: "m2",
        speaker: "deco",
        body: "Diagnosis: it's the origin, not VTEX itself. The vestidos collection loader has no timeout against VTEX search, so under load it hangs and the edge returns 5xx. Same shape as the indexing lag we've seen before — but this one is in my reach because it surfaces as CDN errors.",
      },
      {
        id: "m3",
        speaker: "deco",
        body: "Impact: dresses is a top-3 mobile revenue PLP. At this error rate that's ~R$12k/h at risk. I'd treat this as critical.",
      },
      {
        id: "m4",
        speaker: "deco",
        body: "I drafted a fix (change #3318): a 2s timeout, retry with backoff, and a fallback to the last good ordering so the page never hangs. QA passed the purchase journey and AI review is clean. Approve and I'll publish it, then watch the error rate and tell you if it doesn't settle.",
      },
    ],
  },
  {
    id: "inc-pagination",
    title: "Pagination silently stopped on /novidades",
    brief: "pagination silently broke on page 2 of /novidades",
    trigger: {
      event: "system_health.behavior_anomaly",
      signal:
        "Sessions reaching page 2 of /novidades fell from ~1,180/h to near zero after yesterday's release — no errors logged.",
    },
    severity: "warning",
    layer: "app",
    state: "needs_review",
    autonomy: "propose",
    service: "/novidades (page 2+)",
    detectedAt: "Today, 09:40",
    multiplier: "—",
    errorsPerMin: 0,
    impact: "~38% of PLP sessions scroll past page 1 — they now hit nothing",
    blurb:
      "No error was logged — page 2 just stopped returning products. I caught it by watching behaviour, not logs. This is the kind I used to miss.",
    baseline: 1180,
    spike: drop(1180, 40),
    fix: {
      pr: 3320,
      title: "Restore page 2 on the new-arrivals listing",
      summary:
        "Yesterday's release changed the cursor param; the page-2 request now sends an empty cursor and gets back zero products. Restores the cursor mapping and adds a guard that flags empty paginated responses.",
      filesChanged: 1,
      additions: 12,
      deletions: 3,
      qa: "passed",
      aiReview: "passed",
      diff: "- fetchPage({ cursor })\n+ fetchPage({ cursor: cursor ?? firstCursor })",
    },
    thread: [
      {
        id: "m1",
        speaker: "deco",
        body: "Heads up — this one has no error logs at all, so the old monitoring would have stayed silent. I watch behaviour too: sessions reaching page 2 of /novidades dropped from ~1,180/h to near zero after yesterday's release.",
      },
      {
        id: "m2",
        speaker: "deco",
        body: "Diagnosis: the release changed the pagination cursor param. Page 2 now sends an empty cursor and VTEX returns zero products — so shoppers scroll and hit nothing. No 5xx, no exception, just empty results.",
      },
      {
        id: "m3",
        speaker: "deco",
        body: "Drafted change #3320 — restores the cursor mapping and adds a guard that flags empty paginated responses so we catch this class faster next time. QA passed. Approve to publish.",
      },
    ],
  },
  {
    id: "inc-cart-hydration",
    title: "New error on mobile product pages",
    brief: "a new add-to-cart error on mobile product pages",
    trigger: {
      event: "system_health.application_error",
      signal:
        "New TypeError on /produto/* (mobile) — ~140/min, no prior baseline, started right after this morning's release.",
    },
    severity: "warning",
    layer: "app",
    state: "needs_review",
    autonomy: "propose",
    service: "/produto/* (mobile)",
    detectedAt: "Today, 06:02",
    multiplier: "new",
    errorsPerMin: 140,
    impact: "Add-to-cart may fail for a slice of mobile sessions",
    blurb:
      "A TypeError I've never seen before started firing on mobile PDPs right after this morning's release.",
    baseline: 0,
    spike: ramp(0, 140),
    fix: {
      pr: 3319,
      title: "Guard add-to-cart on mobile until a size is selected",
      summary:
        "The cart store reads `variant.sku` before a variant is picked on mobile, throwing on first paint. Adds a guard and defers hydration until a variant exists.",
      filesChanged: 1,
      additions: 8,
      deletions: 2,
      qa: "running",
      aiReview: "passed",
      diff: "+ if (!variant) return;\n  hydrateCart(variant.sku)",
    },
    thread: [
      {
        id: "m1",
        speaker: "deco",
        body: "New error type appeared at 06:02, right after the morning release: a TypeError during cart hydration on mobile product pages (~140/min). It's new — no baseline — so I'm flagging it early.",
      },
      {
        id: "m2",
        speaker: "deco",
        body: "It reads `variant.sku` before a variant is selected, so it throws on first paint for some mobile sessions. Add-to-cart can fail for them. Drafted change #3319 with a guard. QA is still running the purchase journey — I will hold publishing until it passes.",
      },
    ],
  },
  {
    id: "inc-canonical",
    title: "Fixed missing canonical tags on 3 pages",
    brief: "missing canonical tags on three collection pages",
    trigger: {
      event: "seo.audit",
      signal:
        "Nightly SEO scan: 3 collection pages missing canonical tags — duplicate-content risk.",
    },
    severity: "info",
    layer: "app",
    state: "resolved",
    autonomy: "auto",
    service: "3 collection pages",
    detectedAt: "Today, 02:30",
    multiplier: "—",
    errorsPerMin: 0,
    impact: "SEO — duplicate-content risk removed",
    blurb:
      "Low-risk and reversible, so I shipped it and I'm telling you after: added canonical tags to 3 collection pages.",
    baseline: 0,
    spike: [],
    fix: {
      pr: 3301,
      title: "Add canonical tags to 3 collection pages",
      summary:
        "Three collection pages were missing canonical tags after a template change, risking duplicate-content penalties. Added them. Reversible in one revert.",
      filesChanged: 3,
      additions: 9,
      deletions: 0,
      qa: "passed",
      aiReview: "passed",
      diff: '+ <link rel="canonical" href={canonicalFor(page)} />',
    },
    thread: [
      {
        id: "m1",
        speaker: "deco",
        body: "Handled this one on my own — it's the kind you set me to act on directly (low-risk, reversible). Three collection pages lost their canonical tags in a template change. I added them back (change #3301, published) and QA passed. Flagging it here so you know.",
      },
    ],
  },
  {
    id: "inc-cache-dip",
    title: "Cache hit rate dipped after Tuesday's release",
    brief: "cache hit rate slipping to 88% from 94% after Tuesday's release",
    trigger: {
      event: "system_health.cache_degraded",
      signal:
        "CDN cache hit rate fell from 94% to 88% after Tuesday's release — origin load rising.",
    },
    severity: "info",
    layer: "cdn",
    state: "watching",
    autonomy: "inform",
    service: "site-wide",
    detectedAt: "2d ago",
    multiplier: "—",
    errorsPerMin: 0,
    impact:
      "94% → 88% · slightly higher origin load, no user-facing errors yet",
    blurb:
      "Not an incident — just watching. Cache hit fell 6 points after Tuesday; I'll flag it if it keeps sliding.",
    baseline: 94,
    spike: drop(94, 88),
    thread: [
      {
        id: "m1",
        speaker: "deco",
        body: "Nothing to do here yet — I'm just keeping an eye on it. Cache hit rate fell from 94% to 88% after Tuesday's release. No user-facing errors, just a bit more origin load. If it keeps sliding I'll dig in and propose something.",
      },
    ],
  },
];

export function incidentById(id: string): Incident | undefined {
  return INCIDENTS.find((i) => i.id === id);
}

/** An item's live state = the local override (after an action) or its seed.
 *  Works for any task-like item (System Health incident or CMS proposal). */
export function effectiveState(
  item: { id: string; state: IncidentState },
  overrides: Record<string, IncidentState>,
): IncidentState {
  return overrides[item.id] ?? item.state;
}
