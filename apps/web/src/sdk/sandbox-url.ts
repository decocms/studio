/**
 * The ONE builder for `/api/:org/sandbox/...` URLs.
 *
 * Those routes are branch-scoped, and a branch does not identify a runtime — a
 * coding session shares the CMS draft's branch by design. So every request
 * states WHICH THREAD is asking, and the claim reads that thread's stamp.
 *
 * `threadId` is a required property, not an optional one: a call site that
 * forgets it fails to compile instead of silently resolving the project
 * default. The single legitimate `null` is a project-settings surface with no
 * thread at all, which only reaches pod-addressed routes.
 */
export interface SandboxProxyRef {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  /** The session asking. `null` only for a genuinely thread-less surface. */
  threadId: string | null;
}

/** `path` is appended after the branch segment, e.g. `git/status`, `files/read`. */
export function buildSandboxUrl(
  ref: SandboxProxyRef,
  path: string,
  search?: Record<string, string | undefined>,
): string {
  const base = `/api/${ref.orgSlug}/sandbox/${encodeURIComponent(
    ref.virtualMcpId,
  )}/${encodeURIComponent(ref.branch)}/${path}`;
  const params = new URLSearchParams();
  if (ref.threadId) params.set("thread", ref.threadId);
  for (const [key, value] of Object.entries(search ?? {})) {
    if (value !== undefined) params.set(key, value);
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
