/**
 * Build a valid `vscode://` / `cursor://` deep link for a repo directory.
 *
 * The daemon reports the on-disk path as the host OS spells it. On Windows
 * that's a backslash path with a drive letter (`C:\Users\me\repo`). Naively
 * concatenating `vscode://file${repoDir}` yields `vscode://fileC:\Users\me\repo`,
 * which `window.open` rejects as an invalid URL (missing separator, illegal
 * backslashes). The documented IDE format is `vscode://file/<path>` with the
 * path using forward slashes and a leading slash, e.g.
 * `vscode://file/C:/Users/me/repo` on Windows or `vscode://file/home/me/repo`
 * on POSIX.
 */
export function ideDeepLink(
  scheme: "vscode" | "cursor",
  repoDir: string,
): string {
  const forwardSlashed = repoDir.replace(/\\/g, "/");
  const withLeadingSlash = forwardSlashed.startsWith("/")
    ? forwardSlashed
    : `/${forwardSlashed}`;
  // `encodeURI` escapes spaces/special chars while preserving the `/`
  // separators and the drive `:` (both legal in a URL path), matching the
  // `vscode://file/C:/...` form the IDEs document.
  return `${scheme}://file${encodeURI(withLeadingSlash)}?windowId=_blank`;
}
