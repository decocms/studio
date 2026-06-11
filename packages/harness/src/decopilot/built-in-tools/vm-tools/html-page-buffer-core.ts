import type { UIMessageStreamWriter } from "ai";

const HTML_PAGE_PATTERN = /^pages\/([a-z0-9][a-z0-9._-]*)\.html$/i;

export interface HtmlPageBufferStorage {
  put(
    key: string,
    body: string | Uint8Array,
    options?: { contentType?: string },
  ): Promise<unknown>;
}

function matchHtmlPagePath(
  rawPath: string,
): { slug: string; key: string } | null {
  const normalized = rawPath.replace(/^\.?\//, "");
  const m = HTML_PAGE_PATTERN.exec(normalized);
  if (!m) return null;
  return { slug: m[1]!, key: normalized };
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
  enqueue(rawPath: string, content: string): HtmlPagePreview | null;
  flush(): Promise<void>;
}

export function createHtmlPageBufferFromStorage(params: {
  storage: HtmlPageBufferStorage | null;
  baseUrl: string;
  orgSlug?: string | null;
  writer: UIMessageStreamWriter;
  logPrefix?: string;
}): HtmlPageBuffer {
  const pending = new Map<
    string,
    { slug: string; key: string; content: string }
  >();
  const logPrefix = params.logPrefix ?? "html-page-buffer";

  const enqueue = (
    rawPath: string,
    content: string,
  ): HtmlPagePreview | null => {
    const match = matchHtmlPagePath(rawPath);
    if (!match || !params.orgSlug) return null;
    pending.set(match.key, {
      slug: match.slug,
      key: match.key,
      content,
    });
    return {
      slug: match.slug,
      key: match.key,
      url: toFileDownloadUrl(params.baseUrl, params.orgSlug, match.key),
      bytes: new TextEncoder().encode(content).byteLength,
    };
  };

  const flush = async (): Promise<void> => {
    if (pending.size === 0) return;
    const entries = Array.from(pending.values());
    pending.clear();

    if (!params.orgSlug || !params.storage) {
      console.warn(`[${logPrefix}] flush skipped — storage unavailable`, {
        pendingCount: entries.length,
        hasOrgSlug: Boolean(params.orgSlug),
        hasStorage: Boolean(params.storage),
      });
      return;
    }

    await Promise.allSettled(
      entries.map(async (entry) => {
        try {
          const bytes = new TextEncoder().encode(entry.content);
          await params.storage!.put(entry.key, bytes, {
            contentType: "text/html; charset=utf-8",
          });
          params.writer.write({
            type: "data-html-page-published",
            id: entry.slug,
            data: {
              slug: entry.slug,
              key: entry.key,
              url: toFileDownloadUrl(
                params.baseUrl,
                params.orgSlug!,
                entry.key,
              ),
              bytes: bytes.byteLength,
            },
          });
        } catch (err) {
          console.error(`[${logPrefix}] PUT failed`, { key: entry.key }, err);
        }
      }),
    );
  };

  return { enqueue, flush };
}
