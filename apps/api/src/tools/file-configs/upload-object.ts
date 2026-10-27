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
 */

/** Large enough for a 2x export of a full-width hero, small enough to buffer. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = 30_000;
const MAX_FILES = 20;
const CONCURRENCY = 4;

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
  const contentType = (res.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
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
  return { bytes, contentType };
}

/** Keeps the caller's name, adding an extension from the content type if it has none. */
export function filenameFor(filename: string, contentType: string): string {
  if (/\.[a-z0-9]{2,5}$/i.test(filename)) return filename;
  const ext = contentType.split("/")[1]?.replace("jpeg", "jpg").split("+")[0];
  return ext ? `${filename}.${ext}` : filename;
}

export const FILE_OBJECT_UPLOAD = defineTool({
  name: "FILE_OBJECT_UPLOAD",
  description:
    "Upload files from public https URLs into a configured bucket, the same storage the Assets picker writes to. The server downloads each URL, so short-lived export links work. Returns each file's permanent public URL. Get configId from FILE_CONFIG_LIST (match the site's siteSlug).",
  annotations: {
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    configId: z.string().min(1),
    files: z
      .array(
        z.object({
          url: z.string().url(),
          filename: z
            .string()
            .min(1)
            .max(200)
            .describe("Readable name; the key gets a date shard and a uuid."),
        }),
      )
      .min(1)
      .max(MAX_FILES),
  }),
  outputSchema: z.object({
    files: z.array(
      z.object({
        url: z.string(),
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
      try {
        const { bytes, contentType } = await fetchSource(file.url);
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
          url: file.url,
          publicUrl,
          key,
          contentType,
          size: bytes.byteLength,
        };
      } catch (err) {
        return {
          url: file.url,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
    return { files };
  },
});
