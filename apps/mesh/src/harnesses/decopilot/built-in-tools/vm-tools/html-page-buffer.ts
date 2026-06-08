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

import type { UIMessageStreamWriter } from "ai";
import type { StudioContext } from "@/core/studio-context";
import {
  createBoundObjectStorage,
  type BoundObjectStorage,
} from "@/object-storage/bound-object-storage";
import { DevObjectStorage } from "@/object-storage/dev-object-storage";
import { getObjectStorageS3Service } from "@/object-storage/factory";

const HTML_PAGE_PATTERN = /^pages\/([a-z0-9][a-z0-9._-]*)\.html$/i;

function matchHtmlPagePath(
  rawPath: string,
): { slug: string; key: string } | null {
  const normalized = rawPath.replace(/^\.?\//, "");
  const m = HTML_PAGE_PATTERN.exec(normalized);
  if (!m) return null;
  return { slug: m[1]!, key: normalized };
}

function resolveObjectStorage(ctx: StudioContext): BoundObjectStorage | null {
  if (ctx.objectStorage) return ctx.objectStorage;
  const orgId = ctx.organization?.id;
  if (!orgId) return null;
  const s3Service = getObjectStorageS3Service();
  return s3Service
    ? createBoundObjectStorage(s3Service, orgId)
    : new DevObjectStorage(orgId, ctx.baseUrl);
}

function toFileDownloadUrl(
  baseUrl: string,
  orgSlug: string,
  key: string,
): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${baseUrl}/api/${encodeURIComponent(orgSlug)}/files/${encodedKey}`;
}

export interface HtmlPagePreview {
  slug: string;
  key: string;
  url: string;
  bytes: number;
}

export interface HtmlPageBuffer {
  /**
   * Stage the content for a `pages/<slug>.html` write. Returns the preview
   * shape (or null if the path doesn't match the reserved prefix / org
   * storage isn't resolvable). Bytes are measured against the supplied
   * content; the actual S3 PUT runs in `flush()`.
   */
  enqueue(rawPath: string, content: string): HtmlPagePreview | null;
  /**
   * Flush all buffered paths to S3 in parallel. Idempotent across multiple
   * calls — the second one is a no-op if no new content was enqueued.
   * After each successful PUT, emits a `data-html-page-published` UI part
   * so the side-panel iframe can mount safely.
   */
  flush(): Promise<void>;
}

export function createHtmlPageBuffer(
  ctx: StudioContext,
  writer: UIMessageStreamWriter,
): HtmlPageBuffer {
  const pending = new Map<
    string,
    { slug: string; key: string; content: string }
  >();

  const enqueue = (
    rawPath: string,
    content: string,
  ): HtmlPagePreview | null => {
    const match = matchHtmlPagePath(rawPath);
    if (!match) return null;
    const orgSlug = ctx.organization?.slug;
    if (!orgSlug) return null;
    pending.set(match.key, {
      slug: match.slug,
      key: match.key,
      content,
    });
    return {
      slug: match.slug,
      key: match.key,
      url: toFileDownloadUrl(ctx.baseUrl, orgSlug, match.key),
      bytes: new TextEncoder().encode(content).byteLength,
    };
  };

  const flush = async (): Promise<void> => {
    if (pending.size === 0) return;
    const entries = Array.from(pending.values());
    pending.clear();

    const orgSlug = ctx.organization?.slug;
    const storage = resolveObjectStorage(ctx);
    if (!orgSlug || !storage) {
      console.warn("[html-page-buffer] flush skipped — storage unavailable", {
        pendingCount: entries.length,
        hasOrgSlug: Boolean(orgSlug),
        hasStorage: Boolean(storage),
      });
      return;
    }

    await Promise.allSettled(
      entries.map(async (entry) => {
        try {
          const bytes = new TextEncoder().encode(entry.content);
          await storage.put(entry.key, bytes, {
            contentType: "text/html; charset=utf-8",
          });
          writer.write({
            type: "data-html-page-published",
            id: entry.slug,
            data: {
              slug: entry.slug,
              key: entry.key,
              url: toFileDownloadUrl(ctx.baseUrl, orgSlug, entry.key),
              bytes: bytes.byteLength,
            },
          });
        } catch (err) {
          console.error(
            "[html-page-buffer] PUT failed",
            { key: entry.key },
            err,
          );
        }
      }),
    );
  };

  return { enqueue, flush };
}
