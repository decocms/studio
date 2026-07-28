/**
 * Maps a size/placement tier (`EnsureOptions.tier`) to the SandboxTemplate a
 * claim references. Provider-local: the tier itself is an opaque name in the
 * runner-agnostic contract, and this is the hosted provider's interpretation
 * of it.
 *
 * The sandbox-env chart renders its `defaultTier` at the plain template name
 * and every other tier at `<name>-<tier>`, so an absent tier means "default"
 * and callers never have to know which tier that is.
 */

// A tier is appended to a k8s object name, so it has to be a DNS label.
// Mirrors the sandbox-env chart's validateTiers check.
const TIER_NAME_RE = /^[a-z]([a-z0-9-]{0,14}[a-z0-9])?$/;

/**
 * Resolve the SandboxTemplate name for a tier, falling back to `base` (the
 * default tier) when the tier is absent or malformed.
 *
 * A well-formed tier the chart doesn't define still fails at claim creation
 * with "sandboxtemplate not found" — the runner can't enumerate the chart's
 * tiers, so Studio's tier assignments and the chart's `tiers` keys have to move
 * together. Tier names are operator-supplied config, never user input, but the
 * shape check keeps a stray value from composing a reference to some unrelated
 * object, and falling back beats failing a provision on a typo.
 */
export function templateNameForTier(
  base: string,
  tier: string | undefined,
  onInvalid?: (tier: string) => void,
): string {
  if (!tier) return base;
  if (!TIER_NAME_RE.test(tier)) {
    onInvalid?.(tier);
    return base;
  }
  return `${base}-${tier}`;
}
