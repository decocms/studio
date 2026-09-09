/**
 * The plan feature gate — server side.
 *
 * The client gates too (see `apps/web/src/hooks/use-entitlements.ts`), but that
 * is an upsell: it stops a button, not a request. This is the gate. It sits at
 * the same chokepoint as the block gate (`defineTool`'s execute wrapper), so a
 * tool is covered by DECLARING `requiresFeature`, never by remembering to call
 * something in its handler.
 *
 * Mesh hardcodes only the feature KEYS. Every value is the gateway's answer for
 * that org at that moment, which is what lets a gate move without a mesh deploy.
 */

import { ForbiddenError } from "./access-control";
import type { StudioContext } from "./studio-context";
import { getProviders } from "../ai-providers/registry";
import { mintGatewayJwt } from "../auth/jwt";
import { getSettings } from "../settings";

/** The gate-able surfaces. Mirrors FEATURE_KEYS in the gateway's plans-shape. */
export type PlanFeature =
  | "cms"
  | "chat"
  | "kanban"
  | "monitoring"
  | "model_choice"
  | "diagnostic"
  | "diagnostic_enriched";

/** Thrown when the org's plan does not include the feature. Serialized as 403. */
export class FeatureNotInPlanError extends ForbiddenError {
  readonly code = "feature_not_in_plan";

  constructor(
    message: string,
    readonly feature: PlanFeature,
  ) {
    super(message);
    this.name = "FeatureNotInPlanError";
  }
}

/**
 * A plan changes when a human changes it, and this is read on every gated tool
 * call, so a few minutes of staleness costs less than a gateway round trip per
 * call. Same trade as ORG_NOTICE_CACHE_TTL_MS, same reasoning.
 */
const FEATURES_CACHE_TTL_MS = 60_000;

/**
 * What the gateway last said about an org: which surfaces its plan includes,
 * and how full its AI envelope is. One fetch answers both, so the budget stop
 * costs no extra round trip on top of the feature gate.
 */
interface OrgPlanState {
  features: Record<string, boolean>;
  /**
   * The deco-admin model pin per tier, or null when the gateway declined to
   * answer (it only answers mesh's server or an org that owns `model_choice`).
   * Bare OpenRouter model ids; an absent tier is not pinned.
   */
  modelPins: Record<string, string> | null;
  /**
   * The usage bar's state, or null when the gateway could not READ consumption
   * (`usage: null` on the wire). Null is "unknown", never "exhausted" — see
   * `isUsageBlocked`.
   */
  usageState: BarState | null;
}

type BarState = "ok" | "warn" | "exhausted";

const planStateCache = new Map<string, { state: OrgPlanState; at: number }>();

/** Drop one org's cached plan, so a plan change lands on this instance now. */
export function invalidateOrgFeaturesCache(organizationId: string): void {
  planStateCache.delete(organizationId);
}

/**
 * The org's effective plan state, or null when this deployment has no
 * opinion — no gateway configured (self-hosted), no user to mint a JWT for, or
 * a gateway that could not be reached with nothing cached to fall back on.
 *
 * A refresh failure serves the STALE entry rather than denying: a gateway blip
 * must not take an org's CMS down. It is only when nothing was ever cached that
 * this returns null, and the caller then allows — see `orgHasFeature`.
 */
async function getOrgPlanState(
  ctx: StudioContext,
  organizationId: string,
): Promise<OrgPlanState | null> {
  if (!getSettings().aiGatewayEnabled) return null;

  const hit = planStateCache.get(organizationId);
  if (hit && Date.now() - hit.at < FEATURES_CACHE_TTL_MS) return hit.state;

  const adapter = getProviders().deco;
  if (!adapter?.getEntitlements) return null;

  const userId = ctx.auth.user?.id ?? ctx.auth.apiKey?.userId;
  if (!userId) return hit?.state ?? null;

  try {
    const jwt = await mintGatewayJwt(userId);
    const { features, usage, modelPins } = await adapter.getEntitlements(
      jwt,
      organizationId,
    );
    const state: OrgPlanState = {
      features,
      modelPins,
      usageState: usage?.state ?? null,
    };
    planStateCache.set(organizationId, { state, at: Date.now() });
    return state;
  } catch {
    return hit?.state ?? null;
  }
}

/**
 * Whether the org's plan includes `feature`.
 *
 * FAILS OPEN when the gateway has no answer at all (see `getOrgFeatures`).
 * That is deliberate: a gateway outage that locked every tenant out of its own
 * CMS would be a worse incident than a window of unbilled use, and the spend
 * itself is metered by the gateway regardless of what this returns.
 */
export async function orgHasFeature(
  ctx: StudioContext,
  organizationId: string,
  feature: PlanFeature,
): Promise<boolean> {
  const state = await getOrgPlanState(ctx, organizationId);
  return isFeatureAllowed(state?.features ?? null, feature);
}

/**
 * The allow/deny decision itself, pure.
 *
 * `null` features means "the gateway has no answer" and allows; a features map
 * is authoritative and an ABSENT key denies, exactly as the gateway's
 * `resolveFeatures` intends (absent = denied, never "unknown").
 */
export function isFeatureAllowed(
  features: Record<string, boolean> | null,
  feature: PlanFeature,
): boolean {
  if (!features) return true;
  return features[feature] === true;
}

/**
 * Thrown when the org's AI envelope is spent. Serialized as 403 like every
 * other ForbiddenError, and distinguished by `code` — the client turns this
 * into "your AI allowance is used up" rather than a permission error.
 */
export class AiBudgetExhaustedError extends ForbiddenError {
  readonly code = "ai_budget_exhausted";

  constructor(message: string) {
    super(message);
    this.name = "AiBudgetExhaustedError";
  }
}

/**
 * Whether an exhausted bar should stop AI work right now.
 *
 * Two conditions, both required:
 *
 * 1. `STUDIO_PLAN_USAGE_ENFORCED`. A hard stop on the chat and task dispatch
 *    paths is exactly the kind of change that must ship dormant — "deployed"
 *    must not mean "enabled", and a self-hosted deployment never wants it.
 * 2. A usage state the gateway actually READ. `null` means it could not read
 *    consumption, and the same reasoning as `isFeatureAllowed` applies: a
 *    gateway blip must not stop a paying org's work, and the spend is metered
 *    by the gateway regardless of what this returns.
 *
 * Note this stops only the surfaces that declare it (`requiresAiBudget`, plus
 * the chat route). CMS and monitoring keep working on a full bar — that is the
 * promise the billing card makes: "CMS keeps working, chat pauses".
 */
export function isUsageBlocked(
  usageState: BarState | null,
  enforced: boolean,
): boolean {
  if (!enforced) return false;
  return usageState === "exhausted";
}

/**
 * Refuse when the org has spent its monthly AI envelope. Call it at the point
 * that spends; tools declare `requiresAiBudget` instead (see `defineTool`).
 */
export async function assertAiBudget(
  ctx: StudioContext,
  organizationId: string,
  what: string,
): Promise<void> {
  const state = await getOrgPlanState(ctx, organizationId);
  if (
    !isUsageBlocked(state?.usageState ?? null, getSettings().planUsageEnforced)
  ) {
    return;
  }
  throw new AiBudgetExhaustedError(
    `${what} is paused: this organization has used its monthly AI allowance`,
  );
}

/**
 * The model a deco admin pinned for this org's `tier`, or null.
 *
 * §6 of the pricing doc: model choice is an Ultra feature, so BELOW Ultra deco
 * decides the model and the org is not even told which one ran. The pin is
 * therefore honoured only when the org does NOT own `model_choice` — an Ultra
 * org that bought the right to choose must not have its choice overridden by a
 * leftover pin.
 *
 * Null covers every "no opinion" case and each of them means the same thing to
 * the caller — fall through to your own resolution: no gateway, no pin for this
 * tier, or a gateway that could not be reached. Same fail-open bias as
 * `orgHasFeature`, for the same reason: a blip must not stop an org's chat.
 */
export async function orgPinnedModel(
  ctx: StudioContext,
  organizationId: string,
  tier: string,
): Promise<string | null> {
  const state = await getOrgPlanState(ctx, organizationId);
  if (!state) return null;
  if (isFeatureAllowed(state.features, "model_choice")) return null;
  return state.modelPins?.[tier] ?? null;
}
