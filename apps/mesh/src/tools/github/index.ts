/**
 * GitHub Tools
 *
 * Two generations of tools live here:
 *
 *  1. Legacy: `GITHUB_LIST_USER_ORGS` — uses the old `deco/mcp-github` MCP
 *     connection's shared OAuth token. Kept for now so existing installs keep
 *     working; will be deprecated once UIs migrate to the Decobot flow.
 *
 *  2. Native (Decobot GitHub App): `GITHUB_READ_FILE`, `GITHUB_LIST_REPO_CONTENTS`,
 *     `GITHUB_CREATE_ISSUE`, `GITHUB_COMMENT`, `GITHUB_LIST_PRS`, `GITHUB_READ_PR`.
 *     These resolve a per-call client via `ctx.gitProviders.resolveClient` so
 *     actions are attributed to the calling user when possible, and to the
 *     Decobot installation otherwise — fixing the impersonation problem of (1).
 */

export { GITHUB_LIST_USER_ORGS } from "./list-user-orgs";

// Native Decobot-backed tools
export { GITHUB_READ_FILE } from "./read-file";
export { GITHUB_LIST_REPO_CONTENTS } from "./list-repo-contents";
export { GITHUB_CREATE_ISSUE } from "./create-issue";
export { GITHUB_COMMENT } from "./comment";
export { GITHUB_LIST_PRS } from "./list-prs";
export { GITHUB_READ_PR } from "./read-pr";
