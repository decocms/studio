/** Parse `owner`/`name` from a GitHub clone URL (credentialed or anonymous). */
export function parseGithubOwnerRepo(
  cloneUrl: string,
): { owner: string; name: string } | null {
  try {
    const [owner, rest] = new URL(cloneUrl).pathname
      .replace(/^\//, "")
      .split("/");
    const name = rest?.replace(/\.git$/, "");
    return owner && name ? { owner, name } : null;
  } catch {
    return null;
  }
}
