/**
 * CT stub for `@/hooks/use-hide-default-blog-blocks`. The real hook reads an
 * org flag, which needs the app provider tree this harness doesn't mount. Off
 * here, as for an org that never set it.
 */
export function useHideDefaultBlogBlocks(): boolean {
  return false;
}
