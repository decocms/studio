import type { Database } from "@/storage/types";
import type { Action, Domain } from "@decocms/telos";
import type { Kysely } from "kysely";
import { z } from "zod";
import { requireTelosRuntime } from "./durable/runtime";
import type { OnboardingTarget, ToolTarget } from "./target";

// What the agent perceives: the integrations the org has wired up, and what the
// user has confirmed about themselves. Both are observed — when either moves, the
// agent re-thinks the next step.
export interface OnboardingState {
  // Lowercased identifiers (app_name / slug / title) of active, non-virtual
  // connections — the real tools the org has connected.
  connectedTools: string[];
  // Self-facts the user has confirmed — context the agent reasons over.
  confirmedFacts: Array<{ label: string; value: string }>;
}

// The connection-only slice — enough to decide whether a tool is wired up.
type ToolView = { connectedTools: string[] };

// The tools still to connect — feeds the prompt, the suggestion, and telemetry.
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

// Full observation: connected tools + the self-facts the user has confirmed.
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
  return { connectedTools, confirmedFacts };
}

// A tool counts as connected when any of its match keywords appears in any
// connected integration's identifier.
function isToolConnected(tool: ToolTarget, state: ToolView): boolean {
  return tool.match.some((m) => {
    const needle = m.toLowerCase();
    return state.connectedTools.some((c) => c.includes(needle));
  });
}

// Target tools that became connected between two observed states — drives the
// connection-aware acknowledgment ("you just connected GitHub"). Labels, not raw
// identifiers, so it reads cleanly in a prompt or thought.
export function toolsJustConnected(
  prev: ToolView,
  next: ToolView,
  target: OnboardingTarget,
): string[] {
  return (target.tools ?? [])
    .filter((t) => isToolConnected(t, next) && !isToolConnected(t, prev))
    .map((t) => t.label);
}

// Per-tool connected/not, for the UI's checklist. Tolerant of legacy targets.
export async function onboardingProgress(
  db: Kysely<Database>,
  orgId: string,
  target: OnboardingTarget,
): Promise<Array<{ label: string; connected: boolean }>> {
  const state = await measure(db, orgId);
  return (target.tools ?? []).map((t) => ({
    label: t.label,
    connected: isToolConnected(t, state),
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
): Domain<OnboardingState, OnboardingTarget, OnboardingGap> {
  return {
    name: "mesh-onboarding",
    observe: (tenant) => observeState(db, tenant),
    satisfied: (state, target) => {
      const tools = target.tools ?? [];
      return tools.length > 0 && tools.every((t) => isToolConnected(t, state));
    },
    gap: (state, target) => {
      const missing = (target.tools ?? [])
        .filter((t) => !isToolConnected(t, state))
        .map((t) => t.label);
      return { missing, remaining: missing.length };
    },
    instructions:
      "Pursue the FIXED onboarding target you cannot change. Help the org connect " +
      "the specific tools it names; once all are connected, stop. Never redefine " +
      "the target.",
    actions: onboardingActions,
    prompt: ({ state, target, gap }) =>
      `Onboarding goal: ${target.title}. Tools still to connect: ` +
      `${gap.missing.join(", ") || "none"}.` +
      (state.confirmedFacts.length
        ? ` What the user has confirmed about themselves: ` +
          `${state.confirmedFacts.map((f) => `${f.label} — ${f.value}`).join("; ")}.`
        : "") +
      ` Recommend the single next tool the user should connect, named, and why ` +
      `it helps them.`,
    // Deterministic fallback: recommend connecting the next missing tool by name.
    plan: ({ gap }) => {
      if (gap.remaining <= 0) return [];
      const next = gap.missing[0];
      return [
        {
          kind: "connect_a_tool",
          input: { reason: `Connect ${next} to make progress on your goal` },
        },
      ];
    },
  };
}
