import type { PlanEntitlements } from "../../ai-providers/types";

/**
 * What an ORG may see of its own entitlements.
 *
 * `PlanEntitlements` carries the deco-admin model pin, and §6 of the pricing
 * doc withholds the model's *name* below Ultra — not just the picker. So this
 * is an explicit allowlist rather than a `delete`: a field added to the wire
 * later is omitted by default instead of leaking on the next gateway deploy.
 *
 * Pure and exported so the omission is a unit test rather than a code review.
 */
export type ClientEntitlements = Omit<PlanEntitlements, "modelPins">;

export function toClientEntitlements(
  ent: PlanEntitlements,
): ClientEntitlements {
  return {
    plan: ent.plan,
    features: ent.features,
    usage: ent.usage,
    credits: ent.credits,
    tasks: ent.tasks,
    periodStart: ent.periodStart,
    periodEnd: ent.periodEnd,
  };
}
