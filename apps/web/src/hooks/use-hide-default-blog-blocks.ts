import { useOrgFlag } from "@/hooks/use-organization-settings";

/**
 * Whether the org hid the `deco-cms/blog` built-in post blocks, leaving only
 * the site's own blocks eligible when writing a post.
 */
export function useHideDefaultBlogBlocks(): boolean {
  return useOrgFlag("hide_default_blog_blocks");
}
