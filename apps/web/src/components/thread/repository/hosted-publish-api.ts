/**
 * Publish for a hosted v8 site, on the hosted CMS
 * (`POST /api/:org/cms/:site/drafts/:branch/publish`, contract §4.9): a new
 * revision with the draft over the live one, made live, the draft emptied.
 * A lost race three times over is refused `production_moved`. The answer
 * keeps the shape the publish UI reads: `merged` with the new revision id
 * as `sha`, always `current` (the CDN write is the publish).
 */

import {
  cmsJson,
  CmsRequestError,
  cmsUrl,
} from "@/components/sections-editor/cms-api";

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

/** A refused publish, with the API's error code (`production_moved`). */
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

/** The hosted CMS's publish answer (contract §4.9). */
type CmsPublishAnswer =
  | { result: "published"; revision: string; previous: string | null }
  | { result: "up-to-date"; revision: string };

export async function publishHostedDraft(
  params: { orgSlug: string; site: string | null; branch: string },
  note: string,
): Promise<HostedPublishResult> {
  if (!params.site) {
    throw new HostedPublishError("this project names no site", null);
  }
  let answer: CmsPublishAnswer;
  try {
    answer = await cmsJson<CmsPublishAnswer>(
      await fetch(
        cmsUrl(
          params.orgSlug,
          params.site,
          `drafts/${encodeURIComponent(params.branch)}/publish`,
        ),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: note }),
        },
      ),
    );
  } catch (error) {
    if (error instanceof CmsRequestError) {
      throw new HostedPublishError(error.message, error.code);
    }
    throw error;
  }
  return answer.result === "published"
    ? { result: "merged", sha: answer.revision, release: "current" }
    : { result: "up-to-date" };
}

/**
 * A hosted Publish's review. The hosted CMS has none (no developer edits
 * main under a draft any more): nothing also changed.
 */
export async function readHostedPublishReview(_params: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}): Promise<{ alsoChanged: string[] }> {
  return { alsoChanged: [] };
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
