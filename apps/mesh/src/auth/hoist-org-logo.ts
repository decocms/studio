/**
 * Hoist inline `data:` logos out of organization writes.
 *
 * The org settings form base64-encodes the picked file straight into Better
 * Auth's `organization.logo` column (`organization.update({ data: { logo } })`),
 * which then ships inline in every `organization.list` response — one fat logo
 * bloats the whole list. This `beforeUpdateOrganization` hook uploads the bytes
 * to object storage once and rewrites `logo` to a stable `/files/` URL, reusing
 * the exact live write-sink logic (`createAssetHoister`) so keys/URLs match the
 * `backfill-assets --target organizations` repair. SVG passes through inline
 * (the hoister refuses it — `/files/` serves SVG inline, an XSS vector).
 */

import { getDb } from "../database";
import { getObjectStorageS3Service } from "../object-storage/factory";
import { createBoundObjectStorage } from "../object-storage/bound-object-storage";
import { createAssetHoister } from "../object-storage/asset-hoister";
import { getBaseUrl } from "../core/server-constants";

/** Hoist a single inline logo to storage, returning a `/files/` URL (or the
 * original value when there's nothing to hoist / storage isn't configured). */
export async function hoistOrgLogo(
  orgId: string,
  logo: string,
): Promise<string> {
  const s3Service = getObjectStorageS3Service();
  if (!s3Service) return logo;

  const slug = await getDb()
    .db.selectFrom("organization")
    .select("slug")
    .where("id", "=", orgId)
    .executeTakeFirst();
  if (!slug?.slug) return logo;

  const hoist = createAssetHoister({
    objectStorage: createBoundObjectStorage(s3Service, orgId),
    baseUrl: getBaseUrl(),
    orgSlug: slug.slug,
    prefix: "org-logos",
  });
  return (await hoist(logo)) ?? logo;
}
