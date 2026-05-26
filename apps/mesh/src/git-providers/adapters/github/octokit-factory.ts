/**
 * Thin wrapper around GitHub's REST API.
 *
 * We deliberately avoid `@octokit/rest` here: the call surface used by Studio's
 * tools is small (read file, list contents, create issue, comment, list PRs,
 * read PR) and `fetch` is already the convention in this codebase — see
 * `apps/mesh/src/tools/github/list-user-orgs.ts` for the prior art.
 *
 * Tools call the helpers in this file via the `ResolvedGitClient` returned by
 * the factory; they never construct GitHub URLs by hand.
 */

const GITHUB_API = "https://api.github.com";

/** Standard headers GitHub recommends for REST API v3 calls. */
function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "DecoStudio-Decobot",
  };
}

/**
 * GET against the GitHub REST API. Throws on non-2xx with a readable error
 * message that includes the GitHub-supplied detail. Returns parsed JSON.
 */
export async function githubGet<T = unknown>(
  token: string,
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = new URL(`${GITHUB_API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, { headers: githubHeaders(token) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub ${path} → ${res.status}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

/** POST with a JSON body. */
export async function githubPost<T = unknown>(
  token: string,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: "POST",
    headers: {
      ...githubHeaders(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub ${path} → ${res.status}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

/**
 * Fetch raw content for "diff" or "patch" accept headers — used by
 * GITHUB_READ_PR to also return the unified diff. The standard JSON helper
 * can't handle this since the response isn't JSON.
 */
export async function githubGetText(
  token: string,
  path: string,
  accept: string,
): Promise<string> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      ...githubHeaders(token),
      Accept: accept,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub ${path} → ${res.status}: ${body.slice(0, 500)}`);
  }
  return await res.text();
}
