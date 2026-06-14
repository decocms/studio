import type { Database } from "@/storage/types";
import type { Action, Domain } from "@decocms/telos";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { OnboardingTarget } from "./target";

// What the agent perceives: the two onboarding metrics, counted from Mesh's data.
export interface OnboardingState {
  connections: number;
  automations_run: number;
}

// The distance left on the target metric — feeds the prompt and telemetry.
export interface OnboardingGap {
  metric: OnboardingTarget["metric"];
  current: number;
  remaining: number;
}

async function measure(
  db: Kysely<Database>,
  orgId: string,
): Promise<OnboardingState> {
  const [conn, runs] = await Promise.all([
    // Real, external tool connections the user has wired up (VIRTUAL = agents).
    db
      .selectFrom("connections")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("organization_id", "=", orgId)
      .where("connection_type", "!=", "VIRTUAL")
      .executeTakeFirst(),
    // Automation runs = run threads linked to the org's automation triggers.
    db
      .selectFrom("threads as th")
      .innerJoin("automation_triggers as t", "t.id", "th.trigger_id")
      .select((eb) => eb.fn.count("th.id").as("n"))
      .where("th.organization_id", "=", orgId)
      .where("th.hidden", "=", false)
      .executeTakeFirst(),
  ]);
  return {
    connections: Number(conn?.n ?? 0),
    automations_run: Number(runs?.n ?? 0),
  };
}

// The agent's only honest "hands" during onboarding are recommendations: the
// metrics move when the USER connects a tool or runs an automation, which the
// server can't do for them. So these are "user"-audience actions — the engine
// surfaces them (ctx.suggest → goal.suggestion event) and never performs them.
const SuggestInput = z.object({
  reason: z.string().describe("why this moves the org toward its goal"),
});

const onboardingActions: Action[] = [
  {
    kind: "connect_a_tool",
    description: "Connect an external tool / MCP to the org.",
    audience: "user",
    schema: SuggestInput,
    apply: async () => {
      throw new Error(
        "connect_a_tool is user-only; the engine cannot perform it",
      );
    },
  },
  {
    kind: "run_an_automation",
    description: "Create and run an automation in the org.",
    audience: "user",
    schema: SuggestInput,
    apply: async () => {
      throw new Error(
        "run_an_automation is user-only; the engine cannot perform it",
      );
    },
  },
];

export function onboardingDomain(
  db: Kysely<Database>,
): Domain<OnboardingState, OnboardingTarget, OnboardingGap> {
  return {
    name: "mesh-onboarding",
    observe: (tenant) => measure(db, tenant),
    satisfied: (state, target) => state[target.metric] >= target.targetValue,
    gap: (state, target) => {
      const current = state[target.metric];
      return {
        metric: target.metric,
        current,
        remaining: Math.max(0, target.targetValue - current),
      };
    },
    instructions:
      "Pursue the FIXED onboarding target you cannot change. Help the org reach " +
      "it; once reached, stop. Never redefine the target.",
    actions: onboardingActions,
    prompt: ({ target, gap }) =>
      `Onboarding target: ${target.title} — reach ${target.targetValue} ` +
      `${target.metric.replace(/_/g, " ")}. Currently ${gap.current}; ` +
      `${gap.remaining} to go. Recommend the next step the user should take.`,
    // Deterministic fallback: while there's a gap, recommend the step that maps
    // to the target metric. Both paths surface it as a suggestion (user audience).
    plan: ({ target, gap }) => {
      if (gap.remaining <= 0) return [];
      const kind =
        target.metric === "connections"
          ? "connect_a_tool"
          : "run_an_automation";
      return [
        {
          kind,
          input: {
            reason: `${gap.remaining} ${target.metric.replace(/_/g, " ")} to go`,
          },
        },
      ];
    },
  };
}
