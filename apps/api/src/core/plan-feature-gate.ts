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
  | "diagnostic_enriched"
  /** May buy AI credits on top of the allowance. Free cannot: its $2 trial is
   *  a hard ceiling and the way past it is a plan, not a top-up. */
  | "credits";

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
  /**
   * Wallet dollars the org can still spend, or null when the gateway did not
   * say. Separate pool from the bar on purpose — money cannot move the bar —
   * but it IS spendable, so an exhausted bar with credits behind it must not
   * stop work. See `isUsageBlocked`.
   */
  creditsUsd: number | null;
}

type BarState = "ok" | "warn" | "exhausted";

const planStateCache = new Map<string, { state: OrgPlanState; at: number }>();

/** Cap: entries are only ever overwritten on their own next lookup, never
 *  dropped otherwise, and this is read on every gated tool call. Same bug and
 *  same bound as ARCHIVED_CACHE_MAX_SIZE in context-factory.ts. */
const PLAN_STATE_CACHE_MAX_SIZE = 10_000;

/** Write (or refresh) an entry, moving it to the most-recently-set position.
 *  `Map.set` on an existing key keeps its original iteration position, so a
 *  hot org refreshed on every lookup would otherwise sit at the "oldest" end
 *  and be evicted first. Exported for unit testing. */
export function refreshPlanStateCacheEntry(
  cache: Map<string, { state: OrgPlanState; at: number }>,
  organizationId: string,
  state: OrgPlanState,
): void {
  cache.delete(organizationId);
  cache.set(organizationId, { state, at: Date.now() });
}

/** Exported for unit testing. */
export function evictExpiredPlanStateEntries(
  cache: Map<string, { state: OrgPlanState; at: number }>,
  maxSize: number,
  ttlMs: number,
): void {
  if (cache.size <= maxSize) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at >= ttlMs) cache.delete(key);
  }
  // Trims oldest first (Map iteration order = insertion order).
  if (cache.size > maxSize) {
    const excess = cache.size - maxSize;
    let removed = 0;
    for (const key of cache.keys()) {
      if (removed >= excess) break;
      cache.delete(key);
      removed++;
    }
  }
}

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
  // The whole feature is dormant unless switched on. Deco prod HAS a gateway,
  // so "no gateway configured" is not the off switch this needs — see
  // Settings.plansEnabled.
  if (!getSettings().plansEnabled) return null;
  if (!getSettings().aiGatewayEnabled) return null;

  const hit = planStateCache.get(organizationId);
  if (hit && Date.now() - hit.at < FEATURES_CACHE_TTL_MS) return hit.state;

  const adapter = getProviders().deco;
  if (!adapter?.getEntitlements) return null;

  const userId = ctx.auth.user?.id ?? ctx.auth.apiKey?.userId;
  if (!userId) return hit?.state ?? null;

  try {
    const jwt = await mintGatewayJwt(userId);
    const { features, usage, modelPins, credits } =
      await adapter.getEntitlements(jwt, organizationId);
    const state: OrgPlanState = {
      features,
      modelPins,
      usageState: usage?.state ?? null,
      creditsUsd: credits?.remainingUsd ?? null,
    };
    refreshPlanStateCacheEntry(planStateCache, organizationId, state);
    evictExpiredPlanStateEntries(
      planStateCache,
      PLAN_STATE_CACHE_MAX_SIZE,
      FEATURES_CACHE_TTL_MS,
    );
    return state;
  } catch (err) {
    // Deliberately still fails open (see the docblock) — but never SILENTLY.
    // A wrong service key or a bad base URL makes every org look like it owns
    // every feature, and swallowing that made it indistinguishable from a
    // healthy free org. One warn line is what turns it into an alertable
    // misconfiguration instead of a permanent invisible one.
    console.warn("[Plans] entitlements lookup failed — gates fail OPEN", {
      organizationId,
      servedStale: !!hit,
      error: err instanceof Error ? err.message : String(err),
    });
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
 * Two conditions, and the second is what keeps the promise the UI makes.
 *
 * 1. A usage state the gateway actually READ. `null` means it could not read
 *    consumption, and the same reasoning as `isFeatureAllowed` applies — a
 *    gateway blip must not stop a paying org's work, and the spend is metered
 *    by the gateway regardless of what this returns.
 * 2. No wallet credit left. The bar is the plan's monthly envelope and money
 *    cannot move it — but credits are still SPENDABLE, and they fund the
 *    provider key directly (`keyFundingMicros` = baseline + allowance + net
 *    granted). Blocking an org that just topped up would refuse work the
 *    gateway would happily meter, while the exhausted copy tells that same
 *    org it may "upgrade or top up". `credits: null` is "the gateway didn't
 *    say", which is unknown, not zero — so it does not manufacture a block.
 *
 * There is deliberately no separate enforcement flag. `STUDIO_PLANS_ENABLED`
 * already governs the whole feature: with it off `getOrgPlanState` answers
 * null, so `usageState` is null and this is false anyway. A second switch for
 * the same feature only creates a state where the bar fills and nothing
 * happens, which is the confusing half-on configuration.
 *
 * Note this stops only the surfaces that declare it (`requiresAiBudget`, plus
 * the chat route). CMS and monitoring keep working on a full bar — that is the
 * promise the billing card makes: "CMS keeps working, chat pauses".
 */
export function isUsageBlocked(
  usageState: BarState | null,
  creditsUsd: number | null,
): boolean {
  if (usageState !== "exhausted") return false;
  return !(creditsUsd !== null && creditsUsd > 0);
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
  if (!isUsageBlocked(state?.usageState ?? null, state?.creditsUsd ?? null)) {
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
