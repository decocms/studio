import { useOrgFlag } from "@/hooks/use-organization-settings";

/**
 * Whether the org turned on the blog's agentic half — the brand context tab,
 * the campaigns inside it, post generation and link suggestions.
 *
 * Off by default. This hides the screens; `requireBlogAi` on the API refuses
 * the tools behind them, so the feature is off over MCP too and an agent
 * cannot spend the org's credits on something it switched off. Still a product
 * flag rather than an access check: who may act for the org is settled before
 * either of these is consulted.
 */
export function useBlogAi(): boolean {
  return useOrgFlag("blog_ai_enabled");
}
