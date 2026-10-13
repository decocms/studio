/**
 * A short-lived grant to write one org-filesystem file through Studio.
 *
 * `PUT_PRESIGNED_URL` hands one out for `_fs/` keys in place of an S3 URL:
 * bytes sent straight to S3 never pass through `OrgFs.write`, so the Library
 * index never learns the file exists. The grant is the whole authentication
 * of the upload route, so it names the org, the file and the member it was
 * minted for, expires, and is signed.
 */

import z from "zod";
import { mintSignedGrant, readSignedGrant } from "@/core/signed-grant";

/** Matches the default `PUT_PRESIGNED_URL` lifetime; longer requests are cut to it. */
export const ORG_FS_UPLOAD_MAX_TTL_SEC = 3600;

const UploadGrantSchema = z.object({
  /** Keeps a grant of another type, signed with the same key, out of this route. */
  purpose: z.literal("org-fs-upload"),
  organizationId: z.string().min(1),
  volume: z.string().min(1),
  path: z.string().min(1),
  userId: z.string().min(1),
  /** Unix ms. */
  expiresAt: z.number(),
});

export type OrgFsUploadGrant = Omit<
  z.infer<typeof UploadGrantSchema>,
  "purpose"
>;

export function mintOrgFsUploadToken(grant: OrgFsUploadGrant): string {
  return mintSignedGrant({ purpose: "org-fs-upload", ...grant });
}

/** The grant, or null when the token is forged, malformed or expired. */
export function verifyOrgFsUploadToken(
  token: string,
  now: number = Date.now(),
): OrgFsUploadGrant | null {
  const parsed = UploadGrantSchema.safeParse(readSignedGrant(token));
  if (!parsed.success || parsed.data.expiresAt <= now) return null;
  const { purpose: _purpose, ...grant } = parsed.data;
  return grant;
}
