import type { Database } from "@/storage/types";
import type { Action, Domain } from "@decocms/telos";
import type { Kysely } from "kysely";
import { z } from "zod";
import { requireTelosRuntime } from "./durable/runtime";
import type { Goal, ToolTarget } from "./target";

// A move the engine knows how to make toward the Goal. The engine PRODUCES these;
// they are not part of the Goal (a Goal is a destination, not a plan).
export type Step =
  // The user connects an external app. We can only recommend — a connection is
  // wired up by the USER — so "done" = the app shows up among active connections.
  | { kind: "connect-app"; id: string; label: string; app: ToolTarget }
  // A concrete task whose completion the engine observes via a named signal (e.g.
  // "mark your storefront repos"). Modeled, but not yet populated — a step is only
  // added once its `signal` is observable in OnboardingState.
  | { kind: "action"; id: string; label: string; signal: string };

// The ordered curriculum toward a Goal — hardcoded by us, walked by the engine.
// Today: bring the user's core storefront tools into Studio. `appName` is the
// EXACT scoped id COLLECTION_REGISTRY_APP_GET resolves (verified against the live
// Deco Store) — never a guess, so a step can never reference an app we can't
// install. The list grows as the engine learns new moves; it branches on the Goal
// once there's more than one.
export function curriculumFor(_goal: Goal): Step[] {
  return [
    {
      kind: "connect-app",
      id: "connect-github",
      label: "Connect GitHub",
      app: {
        label: "GitHub",
        match: ["github"],
        appName: "deco/mcp-github",
        icon: "https://github.githubassets.com/assets/GitHub-Mark-ea2971cee799.png",
      },
    },
    {
      kind: "connect-app",
      id: "connect-vtex",
      label: "Connect VTEX",
      app: {
        label: "VTEX",
        match: ["vtex"],
        appName: "deco/vtex",
        icon: "https://assets.decocache.com/decocms/d08dbe46-1ce2-4e3a-a99b-d2d0e7de7e61/vtex-logo.png",
      },
    },
  ];
}

// The connect-app steps' tools, in order — what the UI renders as the connect
// checklist and what connection-matching measures against.
export function connectTools(goal: Goal): ToolTarget[] {
  return curriculumFor(goal)
    .filter((s): s is Extract<Step, { kind: "connect-app" }> => {
      return s.kind === "connect-app";
    })
    .map((s) => s.app);
}

// What the agent perceives: the integrations the org has wired up, the user's
// confirmed self-facts, and which action steps the engine has observed complete.
// When any of these move, the agent re-thinks the next step.
export interface OnboardingState {
  // Lowercased identifiers (app_name / slug / title) of active, non-virtual
  // connections — the real tools the org has connected.
  connectedTools: string[];
  // Self-facts the user has confirmed — context the agent reasons over.
  confirmedFacts: Array<{ label: string; value: string }>;
  // Signals for completed action steps. Empty until action steps go live; an
  // action step whose `signal` isn't here is treated as not-yet-done.
  completedActions: string[];
}

// The connection-only slice — enough to decide whether a tool is wired up.
type ToolView = { connectedTools: string[] };

// The steps still to complete — feeds the prompt, the suggestion, and telemetry.
export interface OnboardingGap {
  missing: string[];
  remaining: number;
}

async function measure(db: Kysely<Database>, orgId: string): Promise<ToolView> {
  const rows = await db
    .selectFrom("connections")
    .select(["app_name", "slug", "title"])
    .where("organization_id", "=", orgId)
    .where("connection_type", "!=", "VIRTUAL")
    .where("status", "=", "active")
    .execute();
  const connectedTools = rows.flatMap((r) =>
    [r.app_name, r.slug, r.title]
      .filter((s): s is string => Boolean(s))
      .map((s) => s.toLowerCase()),
  );
  return { connectedTools };
}

// Full observation: connected tools + confirmed self-facts. Action-step signals
// plug in here once they exist; none are observable yet, so completedActions = [].
async function observeState(
  db: Kysely<Database>,
  orgId: string,
): Promise<OnboardingState> {
  const [{ connectedTools }, facts] = await Promise.all([
    measure(db, orgId),
    requireTelosRuntime().store.facts.list(orgId),
  ]);
  const confirmedFacts = facts
    .filter((f) => f.status === "confirmed")
    .map((f) => ({ label: f.label, value: f.value }));
  return { connectedTools, confirmedFacts, completedActions: [] };
}

// A connect-app step counts as done when any of its match keywords appears in any
// connected integration's identifier.
function isConnected(match: string[], state: ToolView): boolean {
  return match.some((m) => {
    const needle = m.toLowerCase();
    return state.connectedTools.some((c) => c.includes(needle));
  });
}

// Whether a curriculum step is complete given the observed world.
function isStepComplete(
  step: Step,
  state: OnboardingState | ToolView,
): boolean {
  if (step.kind === "connect-app") return isConnected(step.app.match, state);
  // Action step: complete when its signal has been observed.
  return "completedActions" in state
    ? state.completedActions.includes(step.signal)
    : false;
}

// Connect-app steps the user just wired up between two observed states — drives the
// acknowledgment ("you just connected GitHub"). Labels, not raw identifiers.
export function toolsJustConnected(
  prev: ToolView,
  next: ToolView,
  goal: Goal,
): string[] {
  return connectTools(goal)
    .filter((t) => isConnected(t.match, next) && !isConnected(t.match, prev))
    .map((t) => t.label);
}

// Per-connect-step connected/not, for the UI's checklist.
export async function onboardingProgress(
  db: Kysely<Database>,
  orgId: string,
  goal: Goal,
): Promise<Array<{ label: string; connected: boolean }>> {
  const state = await measure(db, orgId);
  return connectTools(goal).map((t) => ({
    label: t.label,
    connected: isConnected(t.match, state),
  }));
}

// The agent's only honest "hands" during onboarding are recommendations: a tool
// connects when the USER wires it up, which the server can't do for them. So this
// is a "user"-audience action — the engine surfaces it and never performs it.
const SuggestInput = z.object({
  reason: z.string().describe("which tool to connect next and why it helps"),
});

const onboardingActions: Action[] = [
  {
    kind: "connect_a_tool",
    description: "Connect a specific external tool / MCP to the org.",
    audience: "user",
    schema: SuggestInput,
    apply: async () => {
      throw new Error(
        "connect_a_tool is user-only; the engine cannot perform it",
      );
    },
  },
];

export function onboardingDomain(
  db: Kysely<Database>,
): Domain<OnboardingState, Goal, OnboardingGap> {
  return {
    name: "studio-onboarding",
    observe: (tenant) => observeState(db, tenant),
    // The anchor Goal ("100x your storefront operation") is enduring — it has no
    // terminal condition, so it is NEVER satisfied. This is deliberate: the kernel
    // only deliberates while `!satisfied`, so a continuously-unsatisfied Goal keeps
    // the engine alive — it re-thinks (and produces a thought) on every state
    // change and never rests. The curriculum is the gap, not the finish line.
    satisfied: () => false,
    gap: (state, goal) => {
      const missing = curriculumFor(goal)
        .filter((s) => !isStepComplete(s, state))
        .map((s) => s.label);
      return { missing, remaining: missing.length };
    },
    instructions:
      "Pursue the FIXED Goal you cannot change. While the org still has foundational " +
      "steps the engine names, guide it through them in order. Once they are all done, " +
      "keep advancing the Goal with what is now connected — never rest, never redefine " +
      "the Goal, and never invent tools to connect.",
    actions: onboardingActions,
    prompt: ({ state, target: goal, gap }) => {
      const facts = state.confirmedFacts.length
        ? ` What the user has confirmed about themselves: ` +
          `${state.confirmedFacts.map((f) => `${f.label} — ${f.value}`).join("; ")}.`
        : "";
      // Two phases of the same enduring Goal: connect the foundation, then act on it.
      if (gap.remaining > 0) {
        return (
          `Goal: ${goal.title}. Tools still to connect: ${gap.missing.join(", ")}.` +
          facts +
          ` Recommend the single next tool the user should connect, named, and why ` +
          `it moves them toward the Goal.`
        );
      }
      return (
        `Goal: ${goal.title}. The foundational tools are all connected.` +
        facts +
        ` Reflect on the single most valuable next move toward this Goal with what ` +
        `is now connected. Speak to the user directly. Do NOT suggest connecting ` +
        `more tools — focus on what to do with what they have.`
      );
    },
    // Deterministic fallback: recommend the next incomplete connect-app step. Action
    // steps have no engine-emittable action yet, so they're skipped by plan().
    plan: ({ state, target: goal }) => {
      const next = curriculumFor(goal).find((s) => !isStepComplete(s, state));
      if (!next || next.kind !== "connect-app") return [];
      return [
        {
          kind: "connect_a_tool",
          input: { reason: `${next.label} to make progress toward your Goal` },
        },
      ];
    },
  };
}
