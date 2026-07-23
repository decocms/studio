/**
 * File Materializer
 *
 * Two-phase pipeline for handling file attachments in chat messages:
 *
 * Phase 1 — uploadFileParts (called once, before saving to DB)
 *   data: URL  →  org-fs uploads volume  →  studio-storage:{key}  stored in DB
 *   The stable `studio-storage:` URI never expires and is safe to persist.
 *   Bytes land in the `uploads` volume under the thread's folder
 *   (`uploads/<threadId>/<filename>`) — the Library lists them and, on
 *   deployments that mount org-fs into sandboxes, the agent sees them at
 *   `org/upload/<filename>` via the per-run symlink (no copy step). The
 *   studio-storage URI points at the volume's object key (`_fs/uploads/...`),
 *   so the presign pipeline below works unchanged. The legacy
 *   `chat-uploads/<uuid>` keyspace is read-only legacy: old threads' keys
 *   still resolve, new writes never go there.
 *
 * Phase 2 — resolveStorageRefs (called every turn, before the model)
 *   studio-storage:{key}  →  fresh presigned GET URL  (in-memory only)
 *   File parts get a live URL the AI SDK / vision model can fetch.
 *   The text annotation also has a stable redirect URL the LLM can hand
 *   to downstream MCP tools.
 */

import { isLocalMode } from "@/auth/local-mode";
import type { StudioContext } from "@/core/studio-context";
import { fsObjectKey } from "@/file-storage/org-fs-path";
import { detectContentType, toFilesUrl } from "@/object-storage/key-utils";
import type { ChatMessage } from "./types";
import {
  toStudioStorageUri,
  parseStudioStorageKey,
  studioStorageRegex,
} from "./studio-storage-uri";

/**
 * MIME types we never hand to providers as native file parts.
 * Provider support for Office formats is uneven (Anthropic chokes with
 * "Failed to parse [file://...]", others silently ignore the file), and
 * the sandbox skills (pptx-extract, docx, xlsx) consistently produce
 * better results than any provider's native parser. The model picks
 * these up from the annotation text emitted by uploadFileParts — they
 * are already at `org/upload/<name>` in the mounted org filesystem.
 *
 * PDFs stay on the native path — every provider with a `file` capability
 * handles them fine and going through the sandbox would be a regression.
 */
const SANDBOX_ONLY_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

function isSandboxOnlyFilePart(part: { type: string }): boolean {
  return (
    part.type === "file" &&
    "mediaType" in part &&
    typeof (part as { mediaType?: unknown }).mediaType === "string" &&
    SANDBOX_ONLY_MIME_TYPES.has((part as { mediaType: string }).mediaType)
  );
}

// ============================================================================
// Data URL parsing
// ============================================================================

interface ParsedDataUrl {
  mimeType: string;
  bytes: Uint8Array;
}

function parseDataUrl(dataUrl: string): ParsedDataUrl | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return null;
  const [, mimeType, base64] = match;
  try {
    const binary = atob(base64!);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return { mimeType: mimeType!, bytes };
  } catch {
    return null;
  }
}

function mimeTypeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/html": "html",
    "application/json": "json",
  };
  return map[mimeType] ?? "bin";
}

// ============================================================================
// Storage helpers
// ============================================================================

/**
 * Upload raw bytes to org storage.
 * Returns the storage key on success, null when ctx.objectStorage is not available
 * (callers keep the data: URL as-is for base64 inline delivery).
 */
async function uploadBytes(
  bytes: Uint8Array,
  key: string,
  mimeType: string,
  ctx: StudioContext,
): Promise<string | null> {
  if (!ctx.objectStorage) return null;
  try {
    await ctx.objectStorage.put(key, bytes, { contentType: mimeType });
    return key;
  } catch (err) {
    console.error("[file-materializer] Failed to upload file:", err);
    return null;
  }
}

// SigV4 presigned URLs are capped at 7 days by the AWS spec.
const S3_PRESIGNED_EXPIRES_IN = 7 * 24 * 3600; // 7 days (SigV4 max)

/** Ceiling for the dev-only base64 inline (Anthropic's pdf cap is 32MB). */
const MAX_DEV_INLINE_BYTES = 20 * 1024 * 1024;

/**
 * Generate a fresh presigned GET URL for an existing storage key.
 * Used by resolveStorageRefs on every turn.
 * Returns null when ctx.objectStorage is not available.
 */
export async function generatePresignedGetUrl(
  key: string,
  ctx: StudioContext,
): Promise<string | null> {
  if (!ctx.objectStorage) return null;
  try {
    return await ctx.objectStorage.presignedGetUrl(
      key,
      S3_PRESIGNED_EXPIRES_IN,
    );
  } catch (err) {
    console.error("[file-materializer] Failed to generate presigned URL:", err);
    return null;
  }
}

// ============================================================================
// Phase 1 — uploadFileParts
// ============================================================================

/** The composer's attachment marker: `[file:://<encodeURIComponent(name)>]`.
 *  File parts carry it as their `filename`; text-file attachments are decoded
 *  inline as a text part of `<marker>\n<content>` (see web derive-parts.ts). */
const FILE_MARKER_RE = /^\[file::\/\/(.+?)\]$/;
const INLINE_FILE_RE = /^\[file::\/\/(.+?)\]\n([\s\S]*)$/;

function decodeMarkerName(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/**
 * User-facing attachment filename: composer marker unwrapped, basename only
 * (no separators), control chars stripped, with an extension-derived
 * fallback. Org-fs paths accept spaces/unicode, so this stays light.
 */
function attachmentFilename(
  part: { filename?: unknown },
  mimeType: string,
): string {
  let raw =
    typeof part.filename === "string" && part.filename.trim()
      ? part.filename
      : `attachment.${mimeTypeToExtension(mimeType)}`;
  const marker = raw.match(FILE_MARKER_RE);
  if (marker?.[1]) raw = decodeMarkerName(marker[1]);
  const base = raw.split(/[\\/]/).pop() ?? raw;
  const cleaned = [...base]
    .filter((ch) => (ch.codePointAt(0) ?? 0) >= 0x20)
    .join("")
    .trim();
  return cleaned || `attachment.${mimeTypeToExtension(mimeType)}`;
}

/** "report.pdf" → "report (2).pdf" until unused within this message. */
function dedupeFilename(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/**
 * Store one attachment's bytes in the org-fs `uploads` volume under the
 * thread's folder — visible in the Library and (where sandboxes mount
 * org-fs) already inside the sandbox at `org/upload/<filename>` via the
 * per-run symlink. The legacy `chat-uploads/<uuid>` keyspace is write-dead:
 * old threads' keys stay readable through the same presign pipeline, but
 * nothing new lands there. Same filename re-attached on a later turn
 * overwrites the thread's copy (upsert) — "newest attachment wins". On
 * failure returns null and the part keeps its data: URL (the model still
 * sees the file; it just isn't materialized).
 */
async function storeAttachment(
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
  ctx: StudioContext,
  threadId: string | undefined,
): Promise<{ key: string; sandboxPath: string | null } | null> {
  if (!threadId || !ctx.orgFs) {
    console.warn("[file-materializer] uploads-volume write skipped", {
      hasThreadId: Boolean(threadId),
      hasOrgFs: Boolean(ctx.orgFs),
    });
    return null;
  }
  try {
    const path = `${threadId}/${filename}`;
    await ctx.orgFs.write("uploads", path, bytes, {
      actor: ctx.auth?.user?.id ?? "unknown",
      contentType: mimeType,
    });
    return {
      key: fsObjectKey("uploads", path),
      // org-fs is mounted into every sandbox, so the upload is always
      // reachable at this in-sandbox path.
      sandboxPath: `org/upload/${filename}`,
    };
  } catch (err) {
    console.error("[file-materializer] uploads-volume write failed:", err);
    return null;
  }
}

/**
 * Upload file parts that carry `data:` URLs to org-scoped storage.
 * Stores stable `studio-storage:{key}` URIs in the message — safe to persist to DB.
 * The text annotation also uses stable `studio-storage:` URIs and a redirect URL
 * so the caller can reconstruct them without further DB writes.
 *
 * Only the last user message is processed — historical messages are skipped
 * to avoid re-uploading on every turn.
 */
export async function uploadFileParts(
  messages: ChatMessage[],
  ctx: StudioContext,
  opts?: { threadId?: string },
): Promise<ChatMessage[]> {
  if (!ctx.organization) return messages;
  const orgSlug = ctx.organization.slug;
  if (!orgSlug) return messages;

  const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
  if (lastUserIdx === -1) return messages;

  const message = messages[lastUserIdx]!;
  const dataUrlParts = message.parts.filter(
    (p) =>
      p.type === "file" &&
      "url" in p &&
      typeof p.url === "string" &&
      p.url.startsWith("data:"),
  );

  // Text-file attachments arrive decoded INLINE (`<marker>\n<content>` text
  // parts), not as file parts. Mirror their bytes into the uploads volume —
  // the inline text stays (the model reads it with zero tool calls), but the
  // file also exists for the Library and for sandbox scripts.
  const canStore = Boolean(opts?.threadId && ctx.orgFs);
  const inlineFiles = canStore
    ? message.parts.flatMap((p) => {
        if (p.type !== "text" || !("text" in p) || typeof p.text !== "string") {
          return [];
        }
        const m = p.text.match(INLINE_FILE_RE);
        if (!m?.[1] || m[2] === undefined) return [];
        return [{ name: decodeMarkerName(m[1]), content: m[2] }];
      })
    : [];

  if (dataUrlParts.length === 0 && inlineFiles.length === 0) return messages;

  // Filenames are assigned sync (dedupe needs cross-part state); uploads
  // then run in parallel.
  const usedNames = new Set<string>();
  const prepared = dataUrlParts.flatMap((part) => {
    if (
      part.type !== "file" ||
      !("url" in part) ||
      typeof part.url !== "string"
    ) {
      return [];
    }
    const parsed = parseDataUrl(part.url);
    if (!parsed) return [];
    const filename = dedupeFilename(
      attachmentFilename(part as { filename?: unknown }, parsed.mimeType),
      usedNames,
    );
    return [{ dataUrl: part.url, parsed, filename }];
  });
  const preparedInline = inlineFiles.map(({ name, content }) => ({
    filename: dedupeFilename(
      attachmentFilename({ filename: name }, "text/plain"),
      usedNames,
    ),
    content,
  }));

  const uploadResults = await Promise.all([
    ...prepared.map(async ({ dataUrl, parsed, filename }) => {
      const stored = await storeAttachment(
        parsed.bytes,
        parsed.mimeType,
        filename,
        ctx,
        opts?.threadId,
      );
      if (!stored) return null;

      return {
        dataUrl,
        studioStorageUrl: toStudioStorageUri(stored.key),
        redirectUrl: toFilesUrl(ctx.baseUrl, orgSlug, stored.key),
        filename,
        sandboxPath: stored.sandboxPath,
      };
    }),
    ...preparedInline.map(async ({ filename, content }) => {
      const stored = await storeAttachment(
        new TextEncoder().encode(content),
        detectContentType(filename),
        filename,
        ctx,
        opts?.threadId,
      );
      if (!stored) return null;
      return {
        // No data: URL to swap — the inline text part stays untouched.
        dataUrl: null,
        studioStorageUrl: toStudioStorageUri(stored.key),
        redirectUrl: toFilesUrl(ctx.baseUrl, orgSlug, stored.key),
        filename,
        sandboxPath: stored.sandboxPath,
      };
    }),
  ]);

  const successful = uploadResults.filter(
    (r): r is NonNullable<typeof r> => r !== null,
  );
  if (successful.length === 0) return messages;

  // Annotation stored in DB uses stable studio-storage: URIs. Files in the
  // uploads volume also carry their in-sandbox path so the model reads them
  // directly instead of reaching for a copy tool.
  const urlAnnotations = successful
    .map((r) =>
      r.sandboxPath
        ? `- ${r.filename}: ${r.sandboxPath} (tool URL: ${r.studioStorageUrl})`
        : `- ${r.filename}: ${r.studioStorageUrl}`,
    )
    .join("\n");
  const annotationText = successful.some((r) => r.sandboxPath)
    ? `[Attached files — already inside your sandbox; read them at the given path. The tool URL is only for tools that take a URL argument]\n${urlAnnotations}`
    : `[Uploaded files — use these URLs when calling tools]\n${urlAnnotations}`;

  // Replace data: URLs with studio-storage: in file parts (inline text
  // attachments have no data: URL — their text part stays untouched).
  const dataUrlToStudioStorage = new Map<string, string>(
    successful.flatMap((r) =>
      r.dataUrl ? [[r.dataUrl, r.studioStorageUrl] as const] : [],
    ),
  );

  const transformedParts = message.parts.map((part) => {
    if (
      part.type !== "file" ||
      !("url" in part) ||
      typeof part.url !== "string"
    ) {
      return part;
    }
    const storageUrl = dataUrlToStudioStorage.get(part.url);
    if (!storageUrl) return part;
    return { ...part, url: storageUrl };
  });

  // Inject annotation into the first text part
  const firstTextIdx = transformedParts.findIndex((p) => p.type === "text");
  let finalParts: ChatMessage["parts"];
  if (firstTextIdx !== -1) {
    finalParts = transformedParts.map((p, i) => {
      if (i !== firstTextIdx || p.type !== "text") return p;
      return {
        ...p,
        text: `${annotationText}\n\n${"text" in p ? p.text : ""}`.trim(),
      };
    });
  } else {
    finalParts = [
      { type: "text" as const, text: annotationText },
      ...transformedParts,
    ];
  }

  return [
    ...messages.slice(0, lastUserIdx),
    { ...message, parts: finalParts },
    ...messages.slice(lastUserIdx + 1),
  ];
}

// ============================================================================
// Phase 2 — resolveStorageRefs
// ============================================================================

/**
 * Resolve `studio-storage:` URIs in file parts to fresh presigned GET URLs so
 * the AI SDK / vision model can fetch the image. Text parts are left unchanged
 * — they keep the opaque `studio-storage:` references that the LLM passes
 * verbatim to tool arguments. The tool-call interceptor (resolveArgsStorageRefs)
 * converts those references to presigned URLs at call time.
 *
 * Also handles legacy `data:` URLs for threads predating this pipeline.
 */
export async function resolveStorageRefs(
  messages: ChatMessage[],
  ctx: StudioContext,
): Promise<ChatMessage[]> {
  if (!ctx.organization) return messages;

  // First pass: drop sandbox-only file parts (Office formats). The model
  // reads these directly from `org/upload/<name>` (the uploads volume is
  // mounted in the sandbox); the annotation text from uploadFileParts
  // points at the path.
  const filtered = messages.map((msg) => {
    const filteredParts = msg.parts.filter(
      (part) => !isSandboxOnlyFilePart(part),
    );
    return filteredParts.length === msg.parts.length
      ? msg
      : { ...msg, parts: filteredParts };
  });

  // Collect unique studio-storage: keys from remaining file parts (not text)
  const keysToResolve = new Set<string>();
  for (const msg of filtered) {
    for (const part of msg.parts) {
      if (
        part.type === "file" &&
        "url" in part &&
        typeof part.url === "string"
      ) {
        const key = parseStudioStorageKey(part.url);
        if (key) keysToResolve.add(key);
      }
    }
  }

  // Generate fresh presigned URLs for all file-part keys.
  //
  // DEV-ONLY branch: local rigs presign plain-http URLs (DevObjectStorage
  // studio URLs, local MinIO — no TLS on a laptop) and Anthropic rejects
  // non-https file URLs outright. There — and only there — inline the
  // bytes as base64 instead. Gated on local mode, not just the URL scheme,
  // so production can never silently fall into base64-bloated requests; a
  // misconfigured non-local http deployment fails loudly at the provider,
  // same as before.
  const devInline = isLocalMode();
  const keyToResolved = new Map<
    string,
    { kind: "url"; url: string } | { kind: "bytes"; b64: string }
  >();
  await Promise.all(
    Array.from(keysToResolve).map(async (key) => {
      const url = await generatePresignedGetUrl(key, ctx);
      if (!url) return;
      if (devInline && !url.startsWith("https://")) {
        try {
          const bytes = await ctx.objectStorage!.getBytes(key);
          // Re-read + re-encoded on every turn (no cache) — cap it so a big
          // upload doesn't balloon dev model requests; past the cap the URL
          // passes through and fails loudly at the provider, same as before.
          if (bytes.byteLength <= MAX_DEV_INLINE_BYTES) {
            keyToResolved.set(key, {
              kind: "bytes",
              b64: Buffer.from(bytes).toString("base64"),
            });
            return;
          }
          console.warn(
            `[file-materializer] dev inline skipped (${bytes.byteLength}B > ${MAX_DEV_INLINE_BYTES}B):`,
            key,
          );
        } catch (err) {
          console.error(
            "[file-materializer] dev inline read failed; passing URL through:",
            err,
          );
        }
      }
      keyToResolved.set(key, { kind: "url", url });
    }),
  );

  if (keyToResolved.size === 0) {
    // No studio-storage: refs in remaining file parts — safety net for legacy data: URLs
    return legacyMaterialize(filtered, ctx);
  }

  // Replace studio-storage: in file part URLs only; leave text parts untouched
  const resolved = filtered.map((msg) => {
    const newParts = msg.parts.map((part) => {
      if (
        part.type === "file" &&
        "url" in part &&
        typeof part.url === "string"
      ) {
        const key = parseStudioStorageKey(part.url);
        if (key) {
          const entry = keyToResolved.get(key);
          if (entry?.kind === "url") return { ...part, url: entry.url };
          if (entry?.kind === "bytes") {
            const mediaType =
              "mediaType" in part && typeof part.mediaType === "string"
                ? part.mediaType
                : "application/octet-stream";
            return { ...part, url: `data:${mediaType};base64,${entry.b64}` };
          }
        }
      }
      return part;
    });

    const changed = newParts.some((p, i) => p !== msg.parts[i]);
    return changed ? { ...msg, parts: newParts } : msg;
  });

  return resolved;
}

// ============================================================================
// Tool-call interceptor
// ============================================================================

/**
 * Deep-walk a tool-call arguments object and replace every string value that
 * contains a `studio-storage:` URI with a fresh presigned GET URL.
 *
 * Called by the tool middleware in helpers.ts before forwarding the call to
 * the MCP client, so tools always receive a real fetchable URL regardless of
 * what the LLM passed.
 */
export async function resolveArgsStorageRefs(
  args: Record<string, unknown>,
  ctx: StudioContext,
): Promise<Record<string, unknown>> {
  // Collect all studio-storage: keys present anywhere in the args tree
  const keysFound = new Set<string>();
  collectStudioStorageKeys(args, keysFound);
  if (keysFound.size === 0) return args;

  // Resolve all keys to fresh presigned URLs in one batch
  const keyToPresigned = new Map<string, string>();
  await Promise.all(
    Array.from(keysFound).map(async (key) => {
      const url = await generatePresignedGetUrl(key, ctx);
      if (url) keyToPresigned.set(key, url);
    }),
  );

  if (keyToPresigned.size === 0) return args;
  return substituteValues(args, keyToPresigned) as Record<string, unknown>;
}

function collectStudioStorageKeys(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(studioStorageRegex())) {
      out.add(match[1]!);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectStudioStorageKeys(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStudioStorageKeys(v, out);
    }
  }
}

function substituteValues(
  value: unknown,
  keyToPresigned: Map<string, string>,
): unknown {
  if (typeof value === "string") {
    return value.replace(
      studioStorageRegex(),
      (_, key: string) => keyToPresigned.get(key) ?? toStudioStorageUri(key),
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteValues(item, keyToPresigned));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        substituteValues(v, keyToPresigned),
      ]),
    );
  }
  return value;
}

// ============================================================================
// Legacy safety net
// ============================================================================

/**
 * Upload any remaining `data:` URLs in the last user message.
 * Only runs when resolveStorageRefs finds no studio-storage: refs —
 * i.e. for threads created before the stable-key pipeline was deployed.
 */
async function legacyMaterialize(
  messages: ChatMessage[],
  ctx: StudioContext,
): Promise<ChatMessage[]> {
  const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
  if (lastUserIdx === -1) return messages;

  const message = messages[lastUserIdx]!;
  const dataUrlParts = message.parts.filter(
    (p) =>
      p.type === "file" &&
      "url" in p &&
      typeof p.url === "string" &&
      p.url.startsWith("data:"),
  );
  if (dataUrlParts.length === 0) return messages;

  const uploadResults = await Promise.all(
    dataUrlParts.map(async (part) => {
      if (
        part.type !== "file" ||
        !("url" in part) ||
        typeof part.url !== "string"
      ) {
        return null;
      }
      const parsed = parseDataUrl(part.url);
      if (!parsed) return null;

      const ext = mimeTypeToExtension(parsed.mimeType);
      const key = `chat-uploads/${crypto.randomUUID()}.${ext}`;
      const uploadedKey = await uploadBytes(
        parsed.bytes,
        key,
        parsed.mimeType,
        ctx,
      );
      if (!uploadedKey) return null;

      const presigned = await generatePresignedGetUrl(uploadedKey, ctx);
      return presigned ? { dataUrl: part.url, presigned } : null;
    }),
  );

  const successful = uploadResults.filter(
    (r): r is NonNullable<typeof r> => r !== null,
  );
  if (successful.length === 0) return messages;

  const dataUrlToPresigned = new Map(
    successful.map((r) => [r.dataUrl, r.presigned]),
  );

  const newParts = message.parts.map((part) => {
    if (
      part.type !== "file" ||
      !("url" in part) ||
      typeof part.url !== "string"
    ) {
      return part;
    }
    const presigned = dataUrlToPresigned.get(part.url);
    return presigned ? { ...part, url: presigned } : part;
  });

  return [
    ...messages.slice(0, lastUserIdx),
    { ...message, parts: newParts },
    ...messages.slice(lastUserIdx + 1),
  ];
}
