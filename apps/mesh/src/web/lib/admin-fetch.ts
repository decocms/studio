/**
 * Fetch wrapper for the deployment-admin API (/api/_admin/*): one place that
 * encodes the surface's error contract ({ error: string } bodies) so the
 * queries and mutations in the admin pages don't each hand-roll it.
 */
export async function adminFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Request failed (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}
