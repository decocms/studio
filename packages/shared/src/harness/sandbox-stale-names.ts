/**
 * Names a prompt must not carry into a sandbox-hosted run: each is a tool that
 * run does not have under that name. Studio tools are named bare, and the
 * runner says how a bare name is called.
 */
export const SANDBOX_STALE_NAMES = [
  "mcp__studio__",
  "`studio` MCP server",
  "user_ask",
  "subtask",
  "propose_plan",
] as const;
