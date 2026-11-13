/**
 * Publish for a hosted v8 site, on the hosted CMS
 * (`POST /api/cms/:site/drafts/:branch/publish`, contract §4.9): a new
 * revision with the draft over the live one, made live, the draft emptied.
 * A lost race three times over is refused `production_moved`. The answer
 * keeps the shape the publish UI reads: `merged` with the new revision id
 * as `sha`. The publish is live once it answers: there is no "Try again".
 */

import {
  cmsRequest,
  CmsRequestError,
  parseCmsPublicationResult,
} from "@/cms/cms-api";

export type HostedPublishResult =
  | { result: "merged"; sha: string }
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

/** Validate the server's success answer before acknowledging a publication. */
export function parseHostedPublishResult(value: unknown): HostedPublishResult {
  const answer = parseCmsPublicationResult(value);
  return answer.result === "published"
    ? { result: "merged", sha: answer.revision }
    : { result: "up-to-date" };
}

export async function publishHostedDraft(
  params: { orgSlug: string; site: string | null; branch: string },
  note: string,
): Promise<HostedPublishResult> {
  if (!params.site) {
    throw new HostedPublishError("this project names no site", null);
  }
  try {
    const answer = await cmsRequest<unknown>(
      params.site,
      `drafts/${encodeURIComponent(params.branch)}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: note }),
      },
    );
    return parseHostedPublishResult(answer);
  } catch (error) {
    if (error instanceof CmsRequestError) {
      throw new HostedPublishError(error.message, error.code);
    }
    throw error;
  }
}
