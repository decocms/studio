import { useOrgFlag } from "@/hooks/use-organization-settings";

/**
 * Whether the org turned on the blog's agentic half — the brand context tab,
 * the campaigns inside it, post generation and link suggestions.
 *
 * Off by default, and it governs what is shown rather than what is callable:
 * the tools stay reachable over MCP, which is the line between a product flag
 * and an access check.
 */
export function useBlogAi(): boolean {
  return useOrgFlag("blog_ai_enabled");
}
