/**
 * swapVirtualMcpAgent — derive a target agent's virtual-MCP URL from the
 * parent run's `mcp.url` by swapping the agent-id path segment.
 *
 * The desktop daemon dispatches a cross-agent subtask by pointing a fresh HTTP
 * MCP client at the TARGET agent's virtual-MCP endpoint, reusing the run's
 * EXISTING minted bearer (no new mint API — decision Q15). The bearer is
 * org-scoped in practice; per-call authorization is enforced at the
 * virtual-MCP endpoint for the target agent id in the path. This helper does
 * ONLY the URL rewrite.
 *
 * Parent URLs look like `<base>/mcp/virtual-mcp/<parentAgentId>` (optionally
 * with a trailing slash). `targetId` replaces the final segment. A `null`/
 * `undefined` target (self-clone) returns the parent URL unchanged.
 */
export function swapVirtualMcpAgent(
  url: string,
  targetId: string | undefined,
): string {
  if (!targetId) return url;
  return url.replace(
    /\/virtual-mcp\/[^/]+\/?$/,
    `/virtual-mcp/${encodeURIComponent(targetId)}`,
  );
}
