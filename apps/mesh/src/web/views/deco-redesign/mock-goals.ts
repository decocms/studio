// Goals — the ROOT object of the redesign (2026-06-08 meetings). Findings are no
// longer the top unit; a GOAL is. You set an outcome + how to verify it +
// constraints, and Deco works toward it by spawning TASKS — the concrete work
// items (a fix, a content change, an investigation). Each task is a real thread
// you can open. There is no user-facing "loop" concept; the goal just spawns
// tasks, and you watch the metric move.
//
// Mock only: the real product reads goals/tasks from the agent's memory + runs.
import type { AutonomyMode } from "./mock-data";

/** A task's lifecycle — what Deco is doing with this slice of the goal. */
export type GoalTaskStatus = "running" | "needs_review" | "done" | "watching";

/** One task the goal spawned. `findingId`, when set, opens the real thread. */
export interface GoalTask {
  id: string;
  title: string;
  status: GoalTaskStatus;
  detail: string; // one line: what it's doing / where it landed
  findingId?: string; // a real finding/thread this task opens (chat route)
}

/** The metric a goal is verified against — current vs target, with a trend. */
export interface GoalMetric {
  label: string;
  value: string;
  target: string;
  deltaPct: number; // period-over-period; sign drives the trend tone
  /** true when a rising number is good (traffic); false when falling is good
   *  (error rate) — drives whether deltaPct reads as healthy. */
  higherIsBetter: boolean;
  spark: number[];
  source: string; // how it's measured, e.g. "Google Search Console"
  sourceIcon?: string; // logo URL for the source connection (else a bolt)
}

/** A goal == an outcome Deco owns. The unit of everything. */
export interface Goal {
  id: string;
  title: string;
  /** Deco's one-line read on where this goal stands right now. */
  summary: string;
  autonomy: AutonomyMode; // how far Deco acts on this goal before a human
  /** A goal can be verified against more than one metric. The first is the
   *  primary (shown on the home card); the detail shows them all. */
  metrics: GoalMetric[];
  constraints: string[];
  tasks: GoalTask[];
  /** Findings (incident / CMS-proposal ids) Deco detected under this goal —
   *  the observations, shown alongside the tasks (the work). */
  findingIds: string[];
}

function ramp(from: number, to: number, n = 16): number[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const jitter = ((i * 7919) % 7) - 3;
    return Math.max(0, Math.round(from + (to - from) * t + jitter));
  });
}

export const GOALS: Goal[] = [
  {
    id: "goal-organic-traffic",
    title: "Grow organic traffic",
    summary:
      "Up 8% this month. I traced the ceiling to catalog content and I'm working through it — one change is ready for your review.",
    autonomy: "propose",
    metrics: [
      {
        label: "Organic sessions",
        value: "1.24M / mo",
        target: "1.40M / mo",
        deltaPct: 8,
        higherIsBetter: true,
        spark: ramp(1060, 1240),
        source: "Google Search Console",
        sourceIcon:
          "https://www.google.com/s2/favicons?domain=search.google.com&sz=64",
      },
      {
        label: "AI-search citation share",
        value: "12%",
        target: "40%",
        deltaPct: 5,
        higherIsBetter: true,
        spark: ramp(7, 12),
        source: "GEO probe",
      },
    ],
    constraints: [
      "On-brand voice only",
      "No thin/auto-spam pages",
      "Don't touch pricing",
    ],
    tasks: [
      {
        id: "task-diagnose",
        title: "Diagnose the organic ceiling",
        status: "done",
        detail:
          "Ranked bottlenecks by traffic at risk — catalog content quality is #1.",
      },
      {
        id: "task-enrich",
        title: "Enrich catalog content",
        status: "running",
        detail: "412 PDPs enriched · impressions +6% on the enriched set.",
      },
      {
        id: "task-geo",
        title: "Win AI-search visibility",
        status: "needs_review",
        detail: "Drafted schema + FAQ for 2 head categories — ready to ship.",
        findingId: "inc-canonical",
      },
      {
        id: "task-programmatic",
        title: "Generate landing pages for long-tail queries",
        status: "running",
        detail:
          "Building on-brand pages for high-intent searches with no page.",
      },
    ],
    findingIds: ["inc-canonical"],
  },
  {
    id: "goal-zero-errors",
    title: "Zero error rate",
    summary:
      "Error rate is 0.9× baseline overall, but a 500 spike on the dresses PLP needs you — a fix is ready. Two more are in flight.",
    autonomy: "propose",
    metrics: [
      {
        label: "Error rate vs baseline",
        value: "0.9×",
        target: "0×",
        deltaPct: -32,
        higherIsBetter: false,
        spark: ramp(140, 40),
        source: "HyperDX + behaviour signals",
        sourceIcon:
          "https://www.google.com/s2/favicons?domain=hyperdx.io&sz=64",
      },
      {
        label: "Uptime",
        value: "99.96%",
        target: "99.99%",
        deltaPct: 1,
        higherIsBetter: true,
        spark: ramp(9990, 9996),
        source: "HyperDX",
        sourceIcon:
          "https://www.google.com/s2/favicons?domain=hyperdx.io&sz=64",
      },
    ],
    constraints: [
      "Never take the store down",
      "Every change reversible",
      "QA must pass before publish",
    ],
    tasks: [
      {
        id: "task-fix-500",
        title: "Fix the dresses PLP 500s",
        status: "needs_review",
        detail:
          "PR #3318 drafted, QA passed, AI review clean — awaiting approval.",
        findingId: "inc-500-vestidos",
      },
      {
        id: "task-pagination",
        title: "Restore pagination on /novidades",
        status: "needs_review",
        detail: "Page 2 returns no products after the release — fix drafted.",
        findingId: "inc-pagination",
      },
      {
        id: "task-cart",
        title: "Guard mobile add-to-cart",
        status: "needs_review",
        detail: "New TypeError on mobile PDPs — fix is in QA.",
        findingId: "inc-cart-hydration",
      },
      {
        id: "task-sweep",
        title: "Sweep other PLPs for the same timeout risk",
        status: "running",
        detail: "Checking every collection loader for the missing timeout.",
      },
      {
        id: "task-cache",
        title: "Watch the cache hit rate",
        status: "watching",
        detail: "Down to 88% after Tuesday's release — keeping an eye on it.",
        findingId: "inc-cache-dip",
      },
    ],
    findingIds: [
      "inc-500-vestidos",
      "inc-pagination",
      "inc-cart-hydration",
      "inc-cache-dip",
    ],
  },
  {
    id: "goal-conversion-content",
    title: "Lift conversion with timely content",
    summary:
      "Mother's Day is 3 days out and the Home still runs the summer hero. I drafted the swap and the Inverno launch — both ready for review.",
    autonomy: "propose",
    metrics: [
      {
        label: "Add-to-cart rate",
        value: "3.8%",
        target: "4.5%",
        deltaPct: 4,
        higherIsBetter: true,
        spark: ramp(330, 380),
        source: "GA4",
        sourceIcon:
          "https://www.google.com/s2/favicons?domain=analytics.google.com&sz=64",
      },
      {
        label: "Mobile conversion",
        value: "2.1%",
        target: "2.6%",
        deltaPct: -3,
        higherIsBetter: true,
        spark: ramp(240, 210),
        source: "GA4",
        sourceIcon:
          "https://www.google.com/s2/favicons?domain=analytics.google.com&sz=64",
      },
    ],
    constraints: [
      "On-brand voice only",
      "Schedule, don't surprise",
      "Revert seasonal content on time",
    ],
    tasks: [
      {
        id: "task-mothers-day",
        title: "Swap in the Mother's Day hero",
        status: "needs_review",
        detail:
          "Drafted copy, CTA and image for the Home hero — ready to publish.",
        findingId: "cms-mothers-day",
      },
      {
        id: "task-inverno",
        title: "Stage the Inverno launch",
        status: "needs_review",
        detail: "3 sections drafted for Home, /inverno and the global bar.",
        findingId: "cms-inverno-campaign",
      },
      {
        id: "task-next-season",
        title: "Prepare the next seasonal swap",
        status: "running",
        detail: "Drafting Father's Day content against the calendar.",
      },
      {
        id: "task-free-shipping",
        title: "Free-shipping announcement bar",
        status: "done",
        detail: "Published a free-shipping-over-R$300 bar — reversible.",
        findingId: "cms-free-shipping",
      },
    ],
    findingIds: [
      "cms-mothers-day",
      "cms-inverno-campaign",
      "cms-free-shipping",
    ],
  },
];

export function goalById(id: string): Goal | undefined {
  return GOALS.find((g) => g.id === id);
}
