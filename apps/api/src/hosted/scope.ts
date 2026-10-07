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
