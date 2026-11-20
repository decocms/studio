import z from "zod";
import { mapBounded } from "@decocms/shared/std";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  putObject,
  resolveFileConfig,
} from "../../file-storage/file-config-s3";
import {
  assertAllowed,
  buildObjectKey,
  UploadRejected,
} from "../../file-storage/upload-policy";
import {
  createNoRedirectFetch,
  guardAgainstPrivateUrl,
  withTimeout,
} from "../../mcp-clients/url-security";
import { readCapped } from "../blog/product-photo";

/**
 * An agent in a sandbox can download a file but holds no credential for the
 * upload route, so without this tool its only public URLs are presigned ones
 * that expire. The server fetches the file itself, which keeps the bytes out
 * of the model's context. The source URL is caller-chosen, so the fetch
 * reuses the SSRF guard and refuses redirects.
 *
 * MCP apps have the opposite problem: the file is already in the browser and
 * there is no public URL to hand over, so a file can also be sent inline as
 * base64.
 */

/** Large enough for a 2x export of a full-width hero, small enough to buffer. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** Inline files travel inside the JSON-RPC body, so they get a tighter cap. */
export const MAX_INLINE_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_BASE64_CHARS = Math.ceil(MAX_INLINE_BYTES / 3) * 4;
const SOURCE_TIMEOUT_MS = 30_000;
const MAX_FILES = 20;
const CONCURRENCY = 4;

/**
 * Narrower than the upload route's allowlist on purpose. What this tool fetches
 * lands at a public URL, and the private-network guard resolves DNS separately
 * from the fetch, so a rebinding host could still reach an internal endpoint.
 * Those answer with text, JSON or HTML; accepting only raster images, video
 * and PDF keeps such a response from ever being published. A PDF must also
 * start with the `%PDF-` signature, so a mislabeled text answer is still
 * refused. SVG is left out because it can carry script.
 */
const MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
  "application/pdf",
]);

const PDF_SIGNATURE = new TextEncoder().encode("%PDF-");

function normalizeMediaType(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase();
}

function assertMediaType(contentType: string): void {
  if (!MEDIA_TYPES.has(contentType)) {
    throw new UploadRejected(
      `Content type "${contentType}" is not allowed; only images, video and PDF.`,
    );
  }
}

function assertMediaBytes(contentType: string, bytes: Uint8Array): void {
  if (
    contentType === "application/pdf" &&
    !PDF_SIGNATURE.every((byte, i) => bytes[i] === byte)
  ) {
    throw new UploadRejected("Body is not a PDF: missing the %PDF- signature.");
  }
}

const noRedirectFetch = createNoRedirectFetch();

export interface FetchedSource {
  bytes: Uint8Array;
  contentType: string;
}

export async function fetchSource(
  url: string,
  deps: {
    guard: (url: string) => Promise<string | null>;
    fetch: (url: string, init?: RequestInit) => Promise<Response>;
  } = { guard: guardAgainstPrivateUrl, fetch: noRedirectFetch },
): Promise<FetchedSource> {
  if (new URL(url).protocol !== "https:") {
    throw new UploadRejected("Only https URLs can be uploaded.");
  }
  const blocked = await deps.guard(url);
  if (blocked) throw new UploadRejected(blocked);

  const res = await withTimeout(
    deps.fetch(url),
    SOURCE_TIMEOUT_MS,
    "Source download timed out",
  );
  if (!res.ok) {
    throw new UploadRejected(`Source answered HTTP ${res.status}.`);
  }
  const contentType = normalizeMediaType(res.headers.get("content-type") ?? "");
  try {
    assertMediaType(contentType);
  } catch (err) {
    await res.body?.cancel();
    throw err;
  }
  const declared = Number(res.headers.get("content-length"));
  // Cheap pre-check; readCapped enforces the cap on the body that arrives.
  assertAllowed(
    contentType,
    Number.isFinite(declared) && declared > 0 ? declared : 1,
  );

  const bytes = await readCapped(res, MAX_SOURCE_BYTES);
  if (!bytes) {
    throw new UploadRejected(`File too large: over ${MAX_SOURCE_BYTES} bytes.`);
  }
  assertAllowed(contentType, bytes.byteLength);
  assertMediaBytes(contentType, bytes);
  return { bytes, contentType };
}

/** Decodes an inline file under the same type rules as a fetched one. */
export function decodeInline(file: {
  content: string;
  contentType: string;
}): FetchedSource {
  const contentType = normalizeMediaType(file.contentType);
  assertMediaType(contentType);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) {
    throw new UploadRejected("content is not valid base64.");
  }
  const bytes = new Uint8Array(Buffer.from(file.content, "base64"));
  if (bytes.byteLength > MAX_INLINE_BYTES) {
    throw new UploadRejected(`File too large: over ${MAX_INLINE_BYTES} bytes.`);
  }
  assertAllowed(contentType, bytes.byteLength);
  assertMediaBytes(contentType, bytes);
  return { bytes, contentType };
}

/** Keeps the caller's name, adding an extension from the content type if it has none. */
export function filenameFor(filename: string, contentType: string): string {
  if (/\.[a-z0-9]{2,5}$/i.test(filename)) return filename;
  const ext = contentType.split("/")[1]?.replace("jpeg", "jpg").split("+")[0];
  return ext ? `${filename}.${ext}` : filename;
}

const FILENAME = z
  .string()
  .min(1)
  .max(200)
  .describe("Readable name; the key gets a date shard and a uuid.");

export const FILE_OBJECT_UPLOAD = defineTool({
  name: "FILE_OBJECT_UPLOAD",
  description:
    "Upload images, videos or PDFs into a configured bucket, the same storage the Assets picker writes to. Each file is either a public https URL, which the server downloads (so short-lived export links work), or inline base64 `content` with its `contentType` (up to 10 MB). Returns each file's permanent public URL. Get configId from FILE_CONFIG_LIST (match the site's siteSlug).",
  annotations: {
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    configId: z.string().min(1),
    files: z
      .array(
        z.union([
          z.object({
            url: z.string().url(),
            filename: FILENAME,
          }),
          z.object({
            content: z
              .string()
              .min(1)
              .max(MAX_INLINE_BASE64_CHARS)
              .describe("File bytes as base64, without a data: prefix."),
            contentType: z.string().min(1),
            filename: FILENAME,
          }),
        ]),
      )
      .min(1)
      .max(MAX_FILES),
  }),
  outputSchema: z.object({
    files: z.array(
      z.object({
        filename: z.string(),
        url: z.string().optional(),
        publicUrl: z.string().optional(),
        key: z.string().optional(),
        contentType: z.string().optional(),
        size: z.number().optional(),
        error: z.string().optional(),
      }),
    ),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const fileCfg = await resolveFileConfig(
      ctx.storage.orgFileConfigs,
      ctx.storage.orgSites,
      input.configId,
      org.id,
    );

    const files = await mapBounded(input.files, CONCURRENCY, async (file) => {
      const source = "url" in file ? { url: file.url } : {};
      try {
        const { bytes, contentType } =
          "url" in file ? await fetchSource(file.url) : decodeInline(file);
        const key = buildObjectKey({
          prefix: fileCfg.info.prefix,
          filename: filenameFor(file.filename, contentType),
        });
        const publicUrl = await putObject({
          ctx: fileCfg,
          key,
          body: bytes,
          contentType,
        });
        return {
          filename: file.filename,
          ...source,
          publicUrl,
          key,
          contentType,
          size: bytes.byteLength,
        };
      } catch (err) {
        return {
          filename: file.filename,
          ...source,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
    return { files };
  },
});
