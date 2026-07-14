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
  const path = repoDir.replace(/\\/g, "/").replace(/^(?!\/)/, "/");
  // Encode each segment so spaces and reserved chars (`#`, `%`, `?`, …) can't
  // corrupt the URL — `encodeURI` leaves those alone, letting a `#` truncate
  // the path into a fragment. Keep the `/` separators and drive-letter `:`
  // literal to match the documented `vscode://file/C:/...` shape.
  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ":"))
    .join("/");
  return `${scheme}://file${encoded}?windowId=_blank`;
}
