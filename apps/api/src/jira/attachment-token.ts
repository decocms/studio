/**
 * A short-lived grant to download one Jira attachment through Studio.
 *
 * The agent's sandbox never holds the Jira credential. `JIRA_ATTACHMENT_DOWNLOAD`
 * mints one of these, the run `curl`s `/api/_jira/attachments/<token>`, and
 * the server spends the integration's token on its behalf. The grant is the
 * whole authentication of that route, so it is bound to the org and the
 * attachment, expires, and is signed — a guess or an edit fails closed.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { getSigningKey } from "@/core/signing-key";

export interface AttachmentGrant {
  organizationId: string;
  attachmentId: string;
  /** Unix ms. */
  expiresAt: number;
}

/** Long enough to run a `curl` inside a step, short enough that a leaked
 *  transcript is not a durable link to a customer's file. */
export const ATTACHMENT_GRANT_TTL_MS = 10 * 60 * 1000;

function sign(payload: string): string {
  return createHmac("sha256", getSigningKey())
    .update(payload)
    .digest("base64url");
}

export function mintAttachmentToken(grant: AttachmentGrant): string {
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The grant a token carries, or null when it is forged, malformed or past
 *  its expiry. `now` is injectable for the test. */
export function verifyAttachmentToken(
  token: string,
  now: number = Date.now(),
): AttachmentGrant | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    return null;
  }
  let grant: unknown;
  try {
    grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
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
