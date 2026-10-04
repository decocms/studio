/**
 * Draft overlay delivery (blocks docs: /next/content-delivery#exact-draft-previews):
 * the two reads a site's `cms.forDraft(pointer)` makes, served from object
 * storage only — no session, no database, no Git provider.
 *
 *   GET /sites/:site/drafts/:version.json      the overlay manifest
 *   GET /sites/:site/draft-blocks/:hash.json   one changed block
 *
 * Mounted at `/api/_delivery`; the delivery host (`DELIVERY_HOST`) routes
 * `/sites/*` here. Every read needs the site's token as the bearer and the
 * pointer's grant (`?token=`), which names the site and one overlay version
 * and expires. A block is served only when the manifest that grant covers
 * lists its hash: knowing a hash unlocks nothing.
 *
 * A manifest response may be cached privately only until its grant expires
 * (`max-age` = the grant's remaining seconds), so a warm site stops serving
 * an expired link; blocks are immutable, and each read of one is checked
 * against a live grant anyway.
 */

import { isValidSiteSlug } from "@decocms/shared/site-slug";
import { Hono, type Context } from "hono";
import { overlayGrant, verifySiteToken } from "@/decofile/draft-token";
import { deliveryKeys, deliveryStorage } from "@/decofile/draft-overlay";
import type { BoundObjectStorage } from "../../object-storage/bound-object-storage";
import { isMissingObject } from "../../object-storage/key-utils";

const ASSET_RE = /^([0-9a-f]{64})\.json$/;

const IMMUTABLE = "private, max-age=31536000, immutable";

function fail(c: Context, status: 401 | 403 | 404 | 500, error: string) {
  return c.json({ error }, status, { "Cache-Control": "no-store" });
}

async function readAsset(
  store: BoundObjectStorage,
  key: string,
): Promise<Uint8Array | null> {
  try {
    return await store.getBytes(key);
  } catch (error) {
    if (isMissingObject(error)) return null;
    throw error;
  }
}

export function createDraftDeliveryRoutes(
  store: () => BoundObjectStorage = deliveryStorage,
) {
  const app = new Hono();

  /** The grant this request carries for `site`, or a failure response. */
  const authorize = (
    c: Context,
    site: string,
  ): { version: string; expiresAt: number } | Response => {
    if (!isValidSiteSlug(site)) return fail(c, 404, "Not found");
    const bearer = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (!bearer || !verifySiteToken(site, bearer)) {
      return fail(c, 401, "Invalid site token");
    }
    const grant = overlayGrant(c.req.query("token") ?? "", { site });
    return grant ?? fail(c, 403, "Invalid or expired draft grant");
  };

  const serve = (c: Context, bytes: Uint8Array, cacheControl: string) =>
    c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      "content-type": "application/json",
      "Cache-Control": cacheControl,
    });

  app.get("/sites/:site/drafts/:file", async (c) => {
    const site = c.req.param("site");
    const granted = authorize(c, site);
    if (granted instanceof Response) return granted;
    const version = ASSET_RE.exec(c.req.param("file"))?.[1];
    if (!version) return fail(c, 404, "Not found");
    if (version !== granted.version) {
      return fail(c, 403, "Grant covers another draft");
    }
    try {
      const manifest = await readAsset(
        store(),
        deliveryKeys.manifest(site, version),
      );
      const secondsLeft = Math.max(
        0,
        granted.expiresAt - Math.floor(Date.now() / 1000),
      );
      return manifest
        ? serve(c, manifest, `private, max-age=${secondsLeft}`)
        : fail(c, 404, "Not found");
    } catch {
      return fail(c, 500, "Draft storage unavailable");
    }
  });

  app.get("/sites/:site/draft-blocks/:file", async (c) => {
    const site = c.req.param("site");
    const granted = authorize(c, site);
    if (granted instanceof Response) return granted;
    const hash = ASSET_RE.exec(c.req.param("file"))?.[1];
    if (!hash) return fail(c, 404, "Not found");
    try {
      const manifest = await readAsset(
        store(),
        deliveryKeys.manifest(site, granted.version),
      );
      if (!manifest) return fail(c, 404, "Not found");
      const { set } = JSON.parse(new TextDecoder().decode(manifest)) as {
        set: Record<string, string>;
      };
      if (!Object.values(set).includes(hash)) {
        return fail(c, 403, "Block is not in the granted draft");
      }
      const block = await readAsset(store(), deliveryKeys.block(site, hash));
      return block ? serve(c, block, IMMUTABLE) : fail(c, 404, "Not found");
    } catch {
      return fail(c, 500, "Draft storage unavailable");
    }
  });

  return app;
}
