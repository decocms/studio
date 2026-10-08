/**
 * Publish for a hosted v8 site (Blocks v8 on GitHub): commits the project's
 * CDN draft straight to main, then releases that commit on the delivery CDN.
 * Publish is done once it's merged; `cdn: "failed"` means running sites don't
 * serve it yet, and Resync on the Releases screen fixes that.
 */

export type HostedPublishResult =
  | { result: "merged"; sha: string; cdn: "live" | "failed" }
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

async function post(url: string, body: unknown): Promise<HostedPublishResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: string;
  } & Partial<HostedPublishResult>;
  if (!res.ok) {
    throw new HostedPublishError(
      json.error ?? `HTTP ${res.status}`,
      json.error ?? null,
    );
  }
  return json as HostedPublishResult;
}

export function publishHostedDraft(
  params: { orgSlug: string; virtualMcpId: string; branch: string },
  note: string,
): Promise<HostedPublishResult> {
  return post(
    `/api/${params.orgSlug}/decofile/${encodeURIComponent(params.virtualMcpId)}/${encodeURIComponent(params.branch)}/publish`,
    { note },
  );
}
