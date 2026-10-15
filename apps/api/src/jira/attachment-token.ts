/**
 * A short-lived grant to download one Jira attachment through Studio.
 *
 * The agent's sandbox never holds the Jira credential. `JIRA_ATTACHMENT_DOWNLOAD`
 * mints one of these, the run `curl`s `/api/_jira/attachments/<token>`, and
 * the server spends the integration's token on its behalf. The grant is the
 * whole authentication of that route, so it is bound to the org and the
 * attachment, expires, and is signed — a guess or an edit fails closed.
 */

import { mintSignedGrant, readSignedGrant } from "@/core/signed-grant";

export interface AttachmentGrant {
  organizationId: string;
  attachmentId: string;
  /** Unix ms. */
  expiresAt: number;
}

/** Long enough to run a `curl` inside a step, short enough that a leaked
 *  transcript is not a durable link to a customer's file. */
export const ATTACHMENT_GRANT_TTL_MS = 10 * 60 * 1000;

export function mintAttachmentToken(grant: AttachmentGrant): string {
  return mintSignedGrant(grant);
}

/** The grant a token carries, or null when it is forged, malformed or past
 *  its expiry. `now` is injectable for the test. */
export function verifyAttachmentToken(
  token: string,
  now: number = Date.now(),
): AttachmentGrant | null {
  const grant = readSignedGrant(token);
  if (
    typeof grant !== "object" ||
    grant === null ||
    typeof (grant as AttachmentGrant).organizationId !== "string" ||
    typeof (grant as AttachmentGrant).attachmentId !== "string" ||
    typeof (grant as AttachmentGrant).expiresAt !== "number"
  ) {
    return null;
  }
  const typed = grant as AttachmentGrant;
  if (typed.expiresAt <= now) return null;
  return typed;
}
