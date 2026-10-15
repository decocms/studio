/**
 * An image for a post, generated and left where a reader can load it.
 *
 * The obvious reuse is `generateImageCore`, and it is the wrong one: that
 * persists to `ctx.objectStorage`, which is served at `/api/:org/files/*` behind
 * a session check. Fine for a chat attachment, useless for a published cover —
 * the first anonymous reader gets a redirect to the login page.
 *
 * A blog cover belongs where a cover uploaded by hand already goes: the
 * organization's own file config, whose `buildPublicUrl` is a real CDN address.
 * So the generation half is borrowed and the storage half is not.
 *
 * Pure enrichment, like the rest of this folder: a post with no cover is a post
 * someone finishes in the editor, and nothing here may be what stops a draft
 * from existing.
 */

import { generateImage } from "ai";
import {
  buildS3Client,
  FileConfigForbiddenError,
  putObject,
  resolveFileConfig,
} from "../../file-storage/file-config-s3";
import {
  assertAllowed,
  buildObjectKey,
} from "../../file-storage/upload-policy";
import { resolveTier } from "../../core/resolve-tier";
import type { StudioContext } from "../../core/studio-context";

/** A cover is a wide hero; the body images follow whatever the block renders. */
const COVER_ASPECT = "16:9" as const;

/** One image, start to finish, before the post waiting on it gives up. */
const IMAGE_TIMEOUT_MS = 90_000;

/** Why an image is missing, in the same code-plus-count shape the gaps use. */
export type ImageOutcome = "ok" | "no-bucket" | "no-model" | "failed";

export interface Painter {
  /** The address a reader can load, or "" when this one could not be made. */
  paint(prompt: string, alt: string): Promise<string>;
  outcome(): ImageOutcome;
}

/** A painter that makes nothing, for the runs that were never going to. */
function barren(outcome: ImageOutcome): Painter {
  return { paint: async () => "", outcome: () => outcome };
}

/**
 * The painter for this run, or one that explains itself.
 *
 * Resolved once per request rather than per image: the model tier and the
 * bucket are the same for every post in a batch, and failing them three times
 * over would be three identical errors in the log. Building the S3 client here
 * also keeps the first image from paying for an STS round trip inside its own
 * timeout.
 */
export async function painterFor(
  ctx: StudioContext,
  organizationId: string,
  fileConfigId: string | undefined,
  label: string,
): Promise<Painter> {
  if (!fileConfigId) return barren("no-bucket");

  let fileCfg: Awaited<ReturnType<typeof resolveFileConfig>>;
  try {
    fileCfg = await resolveFileConfig(
      ctx.storage.orgFileConfigs,
      ctx.storage.orgSites,
      fileConfigId,
      organizationId,
    );
  } catch (err) {
    if (err instanceof FileConfigForbiddenError) throw err;
    console.warn(`[${label}] no bucket to put generated images in`, err);
    return barren("no-bucket");
  }

  let imageModel: Parameters<typeof generateImage>[0]["model"];
  try {
    const tier = await resolveTier(ctx, "image");
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organizationId,
    );
    imageModel = provider.aiSdk.imageModel(tier.modelId);
    buildS3Client(fileCfg);
  } catch (err) {
    console.warn(`[${label}] this organization has no image model`, err);
    return barren("no-model");
  }

  let outcome: ImageOutcome = "ok";
  return {
    outcome: () => outcome,
    paint: async (prompt, alt) => {
      try {
        const result = await generateImage({
          model: imageModel,
          prompt,
          n: 1,
          aspectRatio: COVER_ASPECT,
          abortSignal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
        });
        // Thinking image models emit draft frames; the last is the render.
        const image = result.images.at(-1);
        if (!image) throw new Error("the model returned no image");

        const contentType = image.mediaType ?? "image/png";
        const bytes = Uint8Array.from(atob(image.base64), (c) =>
          c.charCodeAt(0),
        );
        assertAllowed(contentType, bytes.byteLength);
        const key = buildObjectKey({
          prefix: fileCfg.info.prefix,
          filename: `${slugFor(alt)}.${contentType.split("/")[1] ?? "png"}`,
        });
        return await putObject({ ctx: fileCfg, key, body: bytes, contentType });
      } catch (err) {
        outcome = "failed";
        console.warn(`[${label}] could not make an image`, err);
        return "";
      }
    },
  };
}

/** A filename someone can recognise in the bucket listing later. */
export function slugFor(alt: string): string {
  const slug = alt
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "cover";
}
