/**
 * File Materializer
 *
 * Two-phase pipeline for handling file attachments in chat messages:
 *
 * Phase 1 — uploadFileParts (called once, before saving to DB)
 *   data: URL  →  upload to org storage  →  mesh-storage:{key}  stored in DB
 *   The stable `mesh-storage:` URI never expires and is safe to persist.
 *
 * Phase 2 — resolveStorageRefs (called every turn, before the model)
 *   mesh-storage:{key}  →  fresh presigned GET URL  (in-memory only)
 *   File parts get a live URL the AI SDK / vision model can fetch.
 *   The text annotation also has a stable redirect URL the LLM can hand
 *   to downstream MCP tools.
 *
 * Storage backends:
 * - S3 / DevObjectStorage : ctx.objectStorage (BoundObjectStorage) — injected by context-factory
 * - Base64 inline         : data: URL kept as-is in parts — when ctx.objectStorage is null
 */

import type { StudioContext } from "@/core/studio-context";
import { toFilesUrl } from "@/object-storage/key-utils";
import type { ChatMessage } from "./types";
import {
  toMeshStorageUri,
  parseMeshStorageKey,
  meshStorageRegex,
} from "./mesh-storage-uri";

/**
 * MIME types we never hand to providers as native file parts.
 * Provider support for Office formats is uneven (Anthropic chokes with
 * "Failed to parse [file://...]", others silently ignore the file), and
 * the sandbox skills (pptx-extract, docx, xlsx) consistently produce
 * better results than any provider's native parser. The model picks
 * these up from the annotation text emitted by uploadFileParts and
 * pulls them in via copy_to_sandbox.
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

/**
 * Upload file parts that carry `data:` URLs to org-scoped storage.
 * Stores stable `mesh-storage:{key}` URIs in the message — safe to persist to DB.
 * The text annotation also uses stable `mesh-storage:` URIs and a redirect URL
 * so the caller can reconstruct them without further DB writes.
 *
 * Only the last user message is processed — historical messages are skipped
 * to avoid re-uploading on every turn.
 */
export async function uploadFileParts(
  messages: ChatMessage[],
  ctx: StudioContext,
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

  if (dataUrlParts.length === 0) return messages;

  // Upload all data: URL parts in parallel
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

      const filename =
        "filename" in part && typeof part.filename === "string"
          ? part.filename
          : key;

      return {
        dataUrl: part.url,
        meshStorageUrl: toMeshStorageUri(uploadedKey),
        redirectUrl: toFilesUrl(ctx.baseUrl, orgSlug, uploadedKey),
        filename,
      };
    }),
  );

  const successful = uploadResults.filter(
    (r): r is NonNullable<typeof r> => r !== null,
  );
  if (successful.length === 0) return messages;

  // Annotation stored in DB uses stable mesh-storage: URIs
  const urlAnnotations = successful
    .map((r) => `- ${r.filename}: ${r.meshStorageUrl}`)
    .join("\n");
  const annotationText = `[Uploaded files — use these URLs when calling tools]\n${urlAnnotations}`;

  // Replace data: URLs with mesh-storage: in file parts
  const dataUrlToMeshStorage = new Map<string, string>(
    successful.map((r) => [r.dataUrl, r.meshStorageUrl]),
  );

  const transformedParts = message.parts.map((part) => {
    if (
      part.type !== "file" ||
      !("url" in part) ||
      typeof part.url !== "string"
    ) {
      return part;
    }
    const meshUrl = dataUrlToMeshStorage.get(part.url);
    if (!meshUrl) return part;
    return { ...part, url: meshUrl };
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
 * Resolve `mesh-storage:` URIs in file parts to fresh presigned GET URLs so
 * the AI SDK / vision model can fetch the image. Text parts are left unchanged
 * — they keep the opaque `mesh-storage:` references that the LLM passes
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
  // reads these via copy_to_sandbox using the mesh-storage URI in the
  // annotation text emitted by uploadFileParts.
  const filtered = messages.map((msg) => {
    const filteredParts = msg.parts.filter(
      (part) => !isSandboxOnlyFilePart(part),
    );
    return filteredParts.length === msg.parts.length
      ? msg
      : { ...msg, parts: filteredParts };
  });

  // Collect unique mesh-storage: keys from remaining file parts (not text)
  const keysToResolve = new Set<string>();
  for (const msg of filtered) {
    for (const part of msg.parts) {
      if (
        part.type === "file" &&
        "url" in part &&
        typeof part.url === "string"
      ) {
        const key = parseMeshStorageKey(part.url);
        if (key) keysToResolve.add(key);
      }
    }
  }

  // Generate fresh presigned URLs for all file-part keys
  const keyToPresigned = new Map<string, string>();
  await Promise.all(
    Array.from(keysToResolve).map(async (key) => {
      const url = await generatePresignedGetUrl(key, ctx);
      if (url) keyToPresigned.set(key, url);
    }),
  );

  if (keyToPresigned.size === 0) {
    // No mesh-storage: refs in remaining file parts — safety net for legacy data: URLs
    return legacyMaterialize(filtered, ctx);
  }

  // Replace mesh-storage: in file part URLs only; leave text parts untouched
  const resolved = filtered.map((msg) => {
    const newParts = msg.parts.map((part) => {
      if (
        part.type === "file" &&
        "url" in part &&
        typeof part.url === "string"
      ) {
        const key = parseMeshStorageKey(part.url);
        if (key) {
          const presigned = keyToPresigned.get(key);
          if (presigned) return { ...part, url: presigned };
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
 * contains a `mesh-storage:` URI with a fresh presigned GET URL.
 *
 * Called by the tool middleware in helpers.ts before forwarding the call to
 * the MCP client, so tools always receive a real fetchable URL regardless of
 * what the LLM passed.
 */
export async function resolveArgsStorageRefs(
  args: Record<string, unknown>,
  ctx: StudioContext,
): Promise<Record<string, unknown>> {
  // Collect all mesh-storage: keys present anywhere in the args tree
  const keysFound = new Set<string>();
  collectMeshStorageKeys(args, keysFound);
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

function collectMeshStorageKeys(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(meshStorageRegex())) {
      out.add(match[1]!);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectMeshStorageKeys(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectMeshStorageKeys(v, out);
    }
  }
}

function substituteValues(
  value: unknown,
  keyToPresigned: Map<string, string>,
): unknown {
  if (typeof value === "string") {
    return value.replace(
      meshStorageRegex(),
      (_, key: string) => keyToPresigned.get(key) ?? toMeshStorageUri(key),
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
 * Only runs when resolveStorageRefs finds no mesh-storage: refs —
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
