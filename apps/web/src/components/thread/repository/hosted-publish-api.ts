/**
 * Publish for a hosted v8 site (Blocks v8 on GitHub): commits the project's
 * CDN draft straight to main, writes that commit's companion release and
 * makes it current on the CDN. `release` says how far the CDN steps got:
 * `current`, `created` (making it current failed) or `none` (no release was
 * written). Either way the changes are saved on main, and
 * {@link retryRelease} retries the CDN steps ("Try again").
 */

import { mainSchemaHeaders } from "@/hooks/main-schema-changed";

export type HostedPublishResult =
  | {
      result: "merged";
      sha: string;
      release: "current" | "created" | "none";
      /**
       * Not released yet: the draft was kept (the preview keeps showing the
       * changes), and "Try again" empties this save of it once released.
       */
      draftEtag?: string;
    }
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

async function post<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  if (!res.ok) {
    const code = json.error ?? json.code ?? null;
    throw new HostedPublishError(code ?? `HTTP ${res.status}`, code);
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
    // Only a v8 main publishes a hosted draft: a main that changed since is
    // refused (`main_schema_changed`), never merged as a v7 branch.
    mainSchemaHeaders("v8"),
  );
}

/**
 * A hosted Publish's review: the draft's blocks a developer changed on main
 * since the live release. Publish keeps the draft's version of each.
 */
export async function readHostedPublishReview(params: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}): Promise<{ alsoChanged: string[] }> {
  const res = await fetch(
    `/api/${params.orgSlug}/decofile/${encodeURIComponent(params.virtualMcpId)}/${encodeURIComponent(params.branch)}/publish/review`,
    { cache: "no-store", headers: mainSchemaHeaders("v8") },
  );
  if (!res.ok) throw new Error(`publish review read failed: ${res.status}`);
  const body = (await res.json()) as { alsoChanged?: unknown };
  return {
    alsoChanged: Array.isArray(body.alsoChanged)
      ? body.alsoChanged.filter((n): n is string => typeof n === "string")
      : [],
  };
}

/**
 * "Try again" after a Publish that saved the changes but didn't release
 * them: writes the companion release of main's head when it is missing and
 * makes it current. Main's head holds every published change, this one's
 * included, so it never rolls back a newer Publish. With the kept draft
 * (`branch` and Publish's `draftEtag`), the draft is then emptied, unless it
 * was saved again since.
 */
/** The draft a Publish kept for "Try again" to empty, if any. */
export function keptDraftOf(
  result: HostedPublishResult,
  branch: string,
): { branch: string; draftEtag: string } | null {
  return result.result === "merged" && result.draftEtag
    ? { branch, draftEtag: result.draftEtag }
    : null;
}

export function retryRelease(
  params: {
    orgSlug: string;
    virtualMcpId: string;
  },
  keptDraft?: { branch: string; draftEtag: string } | null,
): Promise<unknown> {
  return post<unknown>(
    `/api/${params.orgSlug}/hosted/${encodeURIComponent(params.virtualMcpId)}/releases/retry`,
    keptDraft ?? {},
  );
}
