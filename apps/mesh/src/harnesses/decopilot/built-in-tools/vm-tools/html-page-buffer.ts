/**
 * HTML Page Buffer — coalesces sandbox writes to `pages/<slug>.html` paths.
 *
 * Each call to `enqueue(path, content)` overwrites the buffered content for
 * that path. A burst of write/edit calls on the same slug therefore collapses
 * to a single S3 PUT at flush time. The dispatch layer is expected to call
 * `flush()` from `onStepFinish` (via the run's `pendingOps` queue, which is
 * awaited before the stream closes) so the iframe never sees a 404 race.
 *
 * `enqueue` returns the `htmlPreview` shape the UI chat row already knows
 * (slug, key, url, bytes) so the "Page updated" row paints immediately —
 * only the actual S3 PUT is deferred.
 *
 * After a successful PUT, the buffer emits a `data-html-page-published`
 * UI part via the message stream writer. The side-panel iframe gates its
 * `src` on receiving that signal, so the browser only fetches the URL
 * after the bytes are durably at the key.
 */

import type { StudioContext } from "@/core/studio-context";
import {
  createBoundObjectStorage,
  type BoundObjectStorage,
} from "@/object-storage/bound-object-storage";
import { DevObjectStorage } from "@/object-storage/dev-object-storage";
import { getObjectStorageS3Service } from "@/object-storage/factory";
import type { UIMessageStreamWriter } from "ai";
import {
  createHtmlPageBufferFromStorage,
  type HtmlPageBuffer,
  type HtmlPagePreview,
} from "./html-page-buffer-core";

function resolveObjectStorage(ctx: StudioContext): BoundObjectStorage | null {
  if (ctx.objectStorage) return ctx.objectStorage;
  const orgId = ctx.organization?.id;
  if (!orgId) return null;
  const s3Service = getObjectStorageS3Service();
  return s3Service
    ? createBoundObjectStorage(s3Service, orgId)
    : new DevObjectStorage(orgId, ctx.baseUrl);
}

export type { HtmlPageBuffer, HtmlPagePreview };

export function createHtmlPageBuffer(
  ctx: StudioContext,
  writer: UIMessageStreamWriter,
): HtmlPageBuffer {
  return createHtmlPageBufferFromStorage({
    storage: resolveObjectStorage(ctx),
    baseUrl: ctx.baseUrl,
    orgSlug: ctx.organization?.slug,
    writer,
  });
}
