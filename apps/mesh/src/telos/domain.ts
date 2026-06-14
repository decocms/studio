import type { Database } from "@/storage/types";
import type { Domain } from "@decocms/telos";
import type { Kysely } from "kysely";
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
    // No agent-driven "hands" yet: reaching the target depends on the user
    // connecting tools / running automations, which the server can't do for
    // them, and there is no onboarding action surface to push to. Until real
    // actions exist, the agent observes and measures — adaptiveDeliberator stays
    // on the deterministic path whenever there are no actions to choose among.
    actions: [],
    prompt: ({ target, gap }) =>
      `Onboarding target: ${target.title} — reach ${target.targetValue} ` +
      `${target.metric.replace(/_/g, " ")}. Currently ${gap.current}; ` +
      `${gap.remaining} to go.`,
    plan: () => [],
  };
}
