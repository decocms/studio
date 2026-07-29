/**
 * Sandbox size-tier assignment.
 *
 * A tier is an opaque name (small / medium / large / ...) for a size +
 * placement profile. This module only answers "which tier does this (org,
 * repo) get", from the `STUDIO_SANDBOX_TIER_MAP` overrides parsed in
 * `settings/resolve-config.ts`; what a tier *means* belongs to whichever
 * sandbox provider is active, and nothing here knows how it's implemented (the
 * hosted provider maps a tier to a per-tier SandboxTemplate; a provider
 * without tiering ignores it — see `EnsureOptions.tier`).
 *
 * Deliberately NOT stored on `virtual_mcps.metadata`: that blob is writable by
 * any org member through `VIRTUAL_MCP_UPDATE`, so a tenant could assign itself
 * the largest tier. Assignment has to stay operator-controlled for the tiers
 * to be priceable at all.
 *
 * ponytail: a deploy-time env var, so changing an assignment needs a rollout.
 * Right for the handful of repos that currently need a bigger pod; when the
 * list outgrows an env var, move it to a column on `organization_settings`
 * (non-boolean, so a column and not a `flags` entry) plus an `/api/_admin`
 * tool — the lookup below is the seam that changes.
 */

export interface SandboxTierScope {
  /** Organization slug. Absent (e.g. no org context) → no override applies. */
  orgSlug?: string;
  /** Repo the sandbox clones, when the agent has one attached. */
  repo?: { owner: string; name: string } | null;
}

/**
 * Resolve the tier for a scope, most specific key first:
 *   1. `<orgSlug>/<owner>/<repo>` — one repo of one org
 *   2. `<orgSlug>` — every repo of one org
 *   3. undefined — the provider's own default, so Studio never has to know
 *      which tier that is or what it's called.
 *
 * Keys are matched lowercased (GitHub owner/repo are case-insensitive, and org
 * slugs are already lowercase), so a map written with the casing a human reads
 * off the GitHub UI still matches.
 *
 * An absent map is "no overrides", not a bug: this is an override-only lookup,
 * so nothing configured means every sandbox takes the provider's default —
 * exactly what an empty map means. Typed optional because `getSettings()` is a
 * partial in unit tests, and a provisioning path must not throw over a setting
 * whose whole meaning is "may be unset".
 */
export function resolveSandboxTier(
  map: Record<string, string> | undefined,
  scope: SandboxTierScope,
): string | undefined {
  if (!map) return undefined;
  const org = scope.orgSlug?.trim().toLowerCase();
  if (!org) return undefined;
  if (scope.repo) {
    const owner = scope.repo.owner.trim().toLowerCase();
    const name = scope.repo.name.trim().toLowerCase();
    const byRepo = map[`${org}/${owner}/${name}`];
    if (byRepo) return byRepo;
  }
  return map[org];
}
