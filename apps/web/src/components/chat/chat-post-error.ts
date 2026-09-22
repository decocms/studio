/**
 * What a failed `POST /messages` says to the user.
 *
 * The route answers `{ error, code }` JSON on every refusal, and the caller
 * threw `new Error(await resp.text())` — so the chat's error card rendered the
 * literal `{"error":"..."}` blob, braces, escaped quotes and all. Worse, the
 * two PLAN refusal codes the server takes care to send (`ai_budget_exhausted`,
 * `feature_not_in_plan`) arrived indistinguishable from a crash, so a spent
 * allowance read as a bug in the product rather than a bill to pay.
 *
 * Pure, and its own module so it can be unit-tested without @decocms/ui.
 */

/** Same marker convention as `[CREDITS]` / `[SUBSCRIPTION_REQUIRED]`: the chat
 *  store keeps a plain `Error`, so the message is the only channel a
 *  classification survives on. */
const PLAN_PREFIXES = {
  ai_budget_exhausted: "[PLAN_BUDGET]",
  feature_not_in_plan: "[PLAN_FEATURE]",
} as const;

export type PlanRefusalKind = keyof typeof PLAN_PREFIXES;

/**
 * The message to throw for a non-2xx response body.
 *
 * Anything that isn't our JSON envelope (an HTML error page from a proxy, an
 * empty body, a plain string) falls through unchanged — `parseErrorMessage`
 * already classifies those for display.
 */
export function chatPostErrorMessage(body: string, status: number): string {
  const parsed = parseEnvelope(body);
  if (!parsed) return body || `POST /messages failed (${status})`;
  const prefix = PLAN_PREFIXES[parsed.code as PlanRefusalKind];
  return prefix ? `${prefix} ${parsed.message}` : parsed.message;
}

/** Which plan refusal this error carries, or null. */
export function planRefusalKind(
  error: Error | null | undefined,
): PlanRefusalKind | null {
  const message = error?.message;
  if (!message) return null;
  for (const [kind, prefix] of Object.entries(PLAN_PREFIXES)) {
    if (message.startsWith(prefix)) return kind as PlanRefusalKind;
  }
  return null;
}

function parseEnvelope(
  body: string,
): { message: string; code?: string } | null {
  if (!body.trimStart().startsWith("{")) return null;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const { error, message, code } = json as Record<string, unknown>;
  // `error` is what every route on this path sends; `message` is what a Hono
  // HTTPException serializes to if one ever escapes the handler's own catch.
  const text = typeof error === "string" ? error : message;
  if (typeof text !== "string" || !text) return null;
  return { message: text, ...(typeof code === "string" ? { code } : {}) };
}
