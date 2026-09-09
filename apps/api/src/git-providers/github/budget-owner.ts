/**
 * Which GitHub rate-limit window a token spends.
 *
 * GitHub meters per credential, not per app: every App installation gets its
 * own hourly window, the App's JWT another, each user OAuth grant another.
 * `github_rate_limit_remaining` without that distinction is one series fed by
 * every window in turn, so it reports whichever caller answered last — a `min()`
 * over it cannot say which tenant is out of budget, which is what an operator
 * needs before deciding whom to throttle.
 *
 * The label has to be resolvable from the token because the two biggest
 * spenders — `GithubChangeRequestClient` and the decofile content client —
 * hold only a `TokenSource` and never see an installation id. So the owner is
 * registered where the credential is minted and looked up by the token here.
 * Keyed by a hash: a live credential is not something to hold as a map key.
 */

/** Owner of the window when the token is not one we minted (a PAT, say). */
const UNKNOWN_BUDGET_OWNER = "unknown";

/** The App's own JWT window, which `POST /app/installations/…` spends. */
export const APP_BUDGET_OWNER = "app";

/** A user OAuth grant's own 5,000/hr window, separate from any installation's. */
export const USER_BUDGET_OWNER = "user";

/** Bounds the map if a caller ever registers without expiry churn reclaiming it. */
const MAX_ENTRIES = 512;

const owners = new Map<string, { owner: string; expiresAt: number }>();

function hashKey(token: string): string {
  return Bun.hash(token).toString(36);
}

function prune(now: number): void {
  for (const [key, entry] of owners) {
    if (entry.expiresAt <= now) owners.delete(key);
  }
  while (owners.size >= MAX_ENTRIES) {
    const oldest = owners.keys().next();
    if (oldest.done) break;
    owners.delete(oldest.value);
  }
}

/** Record that `token` spends `owner`'s window until `expiresAt` (epoch ms). */
export function rememberBudgetOwner(
  token: string,
  owner: string,
  expiresAt: number,
  now: number = Date.now(),
): void {
  prune(now);
  owners.set(hashKey(token), { owner, expiresAt });
}

/** The metric label for `token`, or `unknown` when we did not mint it. */
export function budgetOwnerFor(
  token: string,
  now: number = Date.now(),
): string {
  const key = hashKey(token);
  const entry = owners.get(key);
  if (!entry) return UNKNOWN_BUDGET_OWNER;
  if (entry.expiresAt <= now) {
    owners.delete(key);
    return UNKNOWN_BUDGET_OWNER;
  }
  return entry.owner;
}
