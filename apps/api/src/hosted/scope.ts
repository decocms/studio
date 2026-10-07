/**
 * Which projects get the hosted Deco CMS, and the pieces a hosted request
 * needs. Hosted is for Blocks v8 sites on GitHub only (main's
 * `.deco/schema.gen.json` has `"blocksMajor": 8`), behind the
 * `site_editor_content_protocol` org flag; v7 sites never reach it.
 */

import { isValidSiteSlug } from "@decocms/shared/site-slug";
import type { RepoContentClient } from "@/git-providers";
import type { KVStorage } from "@/storage/kv";
import { deliveryStore } from "./delivery-store";
import { createDraftStore, type DraftStore } from "./draft-store";
import { schemaHashOfText } from "./release-objects";

/** The public site id: the project's `metadata.siteSlug`. */
export function projectSite(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const slug = metadata?.siteSlug;
  return typeof slug === "string" && isValidSiteSlug(slug) ? slug : null;
}

/**
 * The project's site id, only when the organization owns that site in
 * `org_sites`. `metadata.siteSlug` is member-editable, so every hosted write
 * (delivery objects, drafts, site tokens) checks ownership before using it.
 */
// OPEN: a project whose siteSlug is not claimed in `org_sites` (claimed today
// by the deco import, the admin claim or the backfill) gets no hosted
// features until the site is claimed for its organization.
export async function ownedProjectSite(
  orgSites: {
    isOwnedBy(slug: string, organizationId: string): Promise<boolean>;
  },
  metadata: Record<string, unknown> | null | undefined,
  organizationId: string,
): Promise<string | null> {
  const site = projectSite(metadata);
  return site && (await orgSites.isOwnedBy(site, organizationId)) ? site : null;
}

/** The draft store over the delivery bucket, or null when none is configured. */
export function hostedDrafts(kv: KVStorage): DraftStore | null {
  const store = deliveryStore();
  return store ? createDraftStore({ kv, store }) : null;
}

/** Whether main's committed schema is a Blocks v8 one. */
export async function mainIsV8(
  client: RepoContentClient,
  packagePath: string | null,
  mainBranch: string,
): Promise<boolean> {
  const path = packagePath
    ? `${packagePath}/.deco/schema.gen.json`
    : ".deco/schema.gen.json";
  const text = await client.readFileAtRef(mainBranch, path);
  return text !== null && (await schemaHashOfText(text)) !== null;
}
