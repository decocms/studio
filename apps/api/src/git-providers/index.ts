/**
 * Talking to a git repository, whoever hosts it.
 *
 * This barrel is the ONLY entry point the rest of the API should import. The
 * layout under it is deliberate:
 *
 * - `types.ts`, `content.ts`, `change-requests.ts` — the contracts. Three,
 *   because the three things Studio does with a repository (hold an account
 *   for it, read and write its files, propose and land changes) have genuinely
 *   different shapes and different callers.
 * - `credentials.ts` — which credential reaches which repository. Neutral.
 * - `clients.ts` — the composition root, and the one module that knows both
 *   providers exist.
 * - `github/`, `gitlab/` — one provider's own vocabulary, and the only place
 *   its name, hosts, endpoints and error prose appear.
 *
 * Two rules keep that honest, and both are about imports:
 *
 * 1. Nothing OUTSIDE this directory imports `github/` or `gitlab/`. If a
 *    caller needs one provider specifically, it wants a capability this
 *    interface does not express yet — add it here rather than reaching past
 *    it. Two standing exceptions, both provider-specific *by construction*:
 *    `api/routes/git-providers.ts` (a GitHub App installation and a GitLab
 *    OAuth grant are different redirect dances, so there is no one flow to
 *    implement) and `tools/github/list-user-orgs.ts` (listing App
 *    installations has no counterpart to abstract over).
 * 2. Nothing INSIDE this directory imports this barrel. Implementations
 *    import the contract file they implement (`../content`, not `..`), which
 *    is what keeps the graph acyclic — the barrel pulls in `clients.ts`, which
 *    pulls in the implementations.
 */

export * from "./types";
export * from "./content";
export * from "./change-requests";
export * from "./credentials";
export * from "./clients";
export * from "./capabilities";

/**
 * The pre-repository world, re-exported so callers still on it need not reach
 * into `github/`. GitHub-only underneath, by construction: a binding written
 * before repositories existed could only ever have been a github.com repo.
 */
export { findRepositoryForLegacyBinding } from "./github/legacy-connection";
