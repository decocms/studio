/**
 * GitHub App installation listing — the one GitHub-shaped tool left.
 *
 * Everything else that used to live here (a branch search, a pull request's
 * state, the last publish) is now provider-neutral: `REPOSITORY_*` and
 * `CHANGE_REQUEST_*`, one interface with a GitHub and a GitLab
 * implementation. What remains is genuinely about a GitHub App installation,
 * which has no counterpart on another provider.
 */

export { GITHUB_LIST_USER_ORGS } from "./list-user-orgs";
