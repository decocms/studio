/**
 * decobot (github.com/decobot, id 114028756) — deco's shared git identity for
 * automated commits when the real author can't be resolved. Its noreply
 * commit-email format is deterministic from its public id+login (no private
 * email lookup or verification needed) and always resolves to a real, verified
 * GitHub account, which is required by GitHub App installation tokens and by
 * private-repo CI/CD collaboration checks (e.g. Vercel) that reject commits
 * whose author can't be matched to an account. Used as the fallback author on
 * every provider. Leaf module: no deps, safe to import anywhere.
 */
export const DECOBOT_GIT_IDENTITY = {
  name: "Deco Bot",
  email: "114028756+decobot@users.noreply.github.com",
} as const;
