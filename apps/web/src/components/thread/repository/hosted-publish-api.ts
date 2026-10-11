/**
 * Publish for a hosted v8 site (Blocks v8 on GitHub): commits the project's
 * CDN draft straight to main, writes that commit's companion release and
 * makes it current on the CDN. `release` says how far the CDN steps got:
 * `current`, `created` (making it current failed) or `none` (no release was
 * written). Either way the changes are saved on main, and
 * {@link publishMainHead} retries the CDN steps ("Try again").
 */

export type HostedPublishResult =
  | { result: "merged"; sha: string; release: "current" | "created" | "none" }
  | { result: "up-to-date" };

/** A refused publish, with the API's error code (`main-moved`). */
export class HostedPublishError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "HostedPublishError";
  }
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new HostedPublishError(
      json.error ?? `HTTP ${res.status}`,
      json.error ?? null,
    );
  }
  return json as T;
}

export function publishHostedDraft(
  params: { orgSlug: string; virtualMcpId: string; branch: string },
  note: string,
): Promise<HostedPublishResult> {
  return post<HostedPublishResult>(
    `/api/${params.orgSlug}/decofile/${encodeURIComponent(params.virtualMcpId)}/${encodeURIComponent(params.branch)}/publish`,
    { note },
  );
}

/**
 * "Try again" after a Publish that saved the changes but didn't put them
 * live: writes the companion release of main's head when it is missing and
 * makes it current. Main's head holds every published change, this one's
 * included, so it never rolls back a newer Publish.
 */
export function publishMainHead(params: {
  orgSlug: string;
  virtualMcpId: string;
}): Promise<unknown> {
  return post<unknown>(
    `/api/${params.orgSlug}/hosted/${encodeURIComponent(params.virtualMcpId)}/releases/current`,
    { head: true },
  );
}
