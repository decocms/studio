/**
 * The `managed` FILE_CONFIG of a site the org owns in `org_sites`: Studio's
 * own asset storage (S3, `assets.decocms.com/<slug>/…`), with prefix-scoped
 * STS credentials minted in-process at upload time (tenant-credentials.ts).
 * It is where a site's assets go from every project mode but a local
 * `deco serve` (hosted, sandbox and v7 alike); the image and file fields
 * lock onto it by `siteSlug`. Created by the deco.cx import and when a
 * project is linked to its site.
 */

import type { OrgFileConfigStorage } from "@/storage/org-file-configs";
import { tenantStorageDescriptor } from "./tenant-credentials";

const FILE_CONFIG_NAME_PREFIX = "deco-assets-";

/**
 * True when a config already IS the managed config for `slug` — the only case
 * where re-provisioning has nothing to do. A same-named config that isn't (the
 * legacy pre-tenancy import created `deco-assets-<site>` pointing at the old
 * assets bucket with vended credentials) must be upgraded in place: the
 * `(organization_id, lower(name))` unique index makes creating a second row
 * impossible, so skipping would strand the org on the legacy bucket forever.
 */
export function isManagedConfigFor(
  config: { credentialType: string; siteSlug: string | null },
  slug: string,
): boolean {
  return (
    config.credentialType === "managed" &&
    config.siteSlug?.toLowerCase() === slug
  );
}

/**
 * Creates (or upgrades a legacy same-named one into) the managed config for
 * `slug`, which the org must already own in `org_sites`. Idempotent: nothing
 * changes when it already is the managed one. Throws on a storage failure;
 * callers treat it as best-effort.
 */
export async function ensureManagedSiteFileConfig(params: {
  fileConfigs: Pick<OrgFileConfigStorage, "list" | "create" | "update">;
  organizationId: string;
  /** The site id (`org_sites` slug), lower case. */
  slug: string;
  /** The name shown in the config (`deco-assets-<siteName>`); the slug by default. */
  siteName?: string;
  by: string;
}): Promise<"exists" | "created" | "upgraded"> {
  const { fileConfigs, organizationId, slug, by } = params;
  const siteName = params.siteName ?? slug;
  const configName = `${FILE_CONFIG_NAME_PREFIX}${siteName}`;
  const existing = (await fileConfigs.list(organizationId)).find(
    (c) => c.name.toLowerCase() === configName.toLowerCase(),
  );
  if (existing && isManagedConfigFor(existing, slug)) return "exists";

  const descriptor = tenantStorageDescriptor(slug);
  const storage = {
    bucket: descriptor.bucket,
    region: descriptor.region,
    endpoint: descriptor.endpoint,
    forcePathStyle: descriptor.forcePathStyle,
    prefix: descriptor.prefix,
    publicUrlBase: descriptor.publicUrlBase,
    // The legacy config carried an sts-session refreshUrl; managed mints
    // in-process, so clear it or the S3 client would still call out to admin.
    refreshUrl: null,
    siteSlug: slug,
    credentials: { type: "managed" as const },
  };
  if (existing) {
    await fileConfigs.update({
      id: existing.id,
      organizationId,
      ...storage,
      updatedBy: by,
    });
    return "upgraded";
  }
  await fileConfigs.create({
    organizationId,
    name: configName,
    description: `Managed deco-assets storage for site "${siteName}".`,
    ...storage,
    createdBy: by,
  });
  return "created";
}
