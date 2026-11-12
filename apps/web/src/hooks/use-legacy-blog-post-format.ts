import { useVirtualMCP } from "@/sdk/hooks/use-virtual-mcp";

/**
 * Whether the project edits a blog post's body as one HTML document in
 * `post.content` — the format sites built before `sections` read — instead of
 * blocks in `post.sections`. A per-project setting (Settings → CMS).
 */
export function useLegacyBlogPostFormat(virtualMcpId?: string | null): boolean {
  const virtualMcp = useVirtualMCP(virtualMcpId);
  return virtualMcp?.metadata?.legacyBlogPostFormat ?? false;
}
