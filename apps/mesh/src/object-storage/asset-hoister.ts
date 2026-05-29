/**
 * Asset hoisting
 *
 * Inline `data:` base64 media (images, audio, video) can arrive on several
 * write paths: connection/virtual-MCP icons (app favicons from the registry,
 * AI-generated brand icons), and tool results that land in thread message
 * `parts`. Persisted verbatim, they get re-inlined into every `COLLECTION_*_LIST`
 * result, which the agent serializes into `thread_messages.parts` — bloating
 * threads by hundreds of KB–MB per call and overflowing NATS/LLM limits.
 *
 * The hoister uploads the bytes to object storage once and stores a directly
 * loadable files URL instead. It returns `${baseUrl}/api/${orgSlug}/files/${key}`
 * — NOT a `mesh-storage://` URI — because icon/media rendering loads the value
 * as a raw `<img src>` / media src and does not resolve the mesh-storage scheme.
 *
 * Applied as a per-request decorator on `storage.connections`/`storage.virtualMcps`
 * /`storage.threads` in the context factory, where `ctx.objectStorage` and the
 * org slug exist (the base storage classes are singletons and have neither).
 * Only `data:(image|audio|video)/*` values are touched; other strings (and
 * non-media data: URIs) pass through.
 */

import { createHash } from "node:crypto";
import type { BoundObjectStorage } from "./bound-object-storage";
import type {
  ConnectionStoragePort,
  VirtualMCPStoragePort,
} from "../storage/ports";
import type { ThreadMessage } from "../storage/types";

const DATA_MEDIA = /^data:((?:image|audio|video)\/[^;]+);base64,(.+)$/s;
/** Default cap on decoded asset size. Larger payloads stay inline rather than
 * decoded into a Buffer, so a pathological data: URI can't OOM the process. */
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const EXT_BY_MIME: Record<string, string> = {
  // image
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  // audio
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
  "audio/aac": "aac",
  // video
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/ogg": "ogv",
  "video/quicktime": "mov",
};

export type AssetHoister = (
  value: string | null | undefined,
) => Promise<string | null | undefined>;

export function createAssetHoister(deps: {
  objectStorage: BoundObjectStorage | null;
  baseUrl: string;
  orgSlug: string | undefined;
  /** Storage key prefix for uploaded assets. */
  prefix?: string;
  /** Max decoded asset size to hoist (bytes). Defaults to 5 MiB. */
  maxBytes?: number;
}): AssetHoister {
  const {
    objectStorage,
    baseUrl,
    orgSlug,
    prefix = "connection-icons",
    maxBytes = MAX_ASSET_BYTES,
  } = deps;
  return async (value) => {
    if (typeof value !== "string") return value;
    const match = value.match(DATA_MEDIA);
    if (!match) return value; // already a URL / not a data: media URI
    if (!objectStorage || !orgSlug) return value; // no storage → leave as-is
    const [, mimeType, b64] = match;
    // Estimate decoded size from the base64 length (≈ len * 3/4) before
    // allocating. Oversized assets stay inline — caps memory at the source.
    if (Math.floor((b64!.length * 3) / 4) > maxBytes) {
      console.warn(
        `[asset-hoister] asset exceeds ${maxBytes} bytes, keeping inline`,
      );
      return value;
    }
    const bytes = Buffer.from(b64!, "base64");
    // Content-addressed key: same bytes → same key → same URL, so retried
    // writes are idempotent (overwrite identical content) and dedup for free.
    const digest = createHash("sha256").update(bytes).digest("hex");
    const key = `${prefix}/${digest}.${EXT_BY_MIME[mimeType!] ?? "bin"}`;
    try {
      await objectStorage.put(key, bytes, {
        contentType: mimeType,
      });
      return `${baseUrl}/api/${orgSlug}/files/${key}`;
    } catch (err) {
      console.error(
        "[asset-hoister] upload failed, keeping inline asset:",
        err,
      );
      return value;
    }
  };
}

/** Recursively replace every inline `data:` media string in a JSON value. */
async function hoistDeep(
  value: unknown,
  hoist: AssetHoister,
): Promise<unknown> {
  if (typeof value === "string") return (await hoist(value)) ?? value;
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => hoistDeep(item, hoist)));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = await hoistDeep(v, hoist);
    }
    return out;
  }
  return value;
}

/**
 * Hoist inline assets on a connection-shaped payload: the top-level `icon`
 * field and any `data:` media nested in the `metadata` object (e.g.
 * `metadata.ui.icon`). Returns a shallow copy with those fields replaced.
 */
async function hoistConnectionData<
  D extends { icon?: string | null; metadata?: unknown },
>(data: D, hoist: AssetHoister): Promise<D> {
  const next: Record<string, unknown> = { ...data };
  if (typeof next.icon === "string") {
    next.icon = await hoist(next.icon);
  }
  if (next.metadata !== null && typeof next.metadata === "object") {
    next.metadata = await hoistDeep(next.metadata, hoist);
  }
  return next as D;
}

/**
 * Decorate a ConnectionStoragePort so create/update hoist inline `data:` media
 * (in `icon` and `metadata`) before persisting. Other methods pass through
 * untouched.
 */
export function withConnectionAssetHoisting<T extends ConnectionStoragePort>(
  base: T,
  hoist: AssetHoister,
): T {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "create") {
        return async (data: Parameters<ConnectionStoragePort["create"]>[0]) =>
          target.create(await hoistConnectionData(data, hoist));
      }
      if (prop === "update") {
        return async (
          id: string,
          data: Parameters<ConnectionStoragePort["update"]>[1],
        ) => target.update(id, await hoistConnectionData(data, hoist));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Decorate a VirtualMCPStoragePort so create/update hoist inline `data:` media
 * (in `icon` and `metadata`).
 */
export function withVirtualMcpAssetHoisting<T extends VirtualMCPStoragePort>(
  base: T,
  hoist: AssetHoister,
): T {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "create") {
        return async (
          organizationId: string,
          userId: string,
          data: Parameters<VirtualMCPStoragePort["create"]>[2],
          options?: Parameters<VirtualMCPStoragePort["create"]>[3],
        ) =>
          target.create(
            organizationId,
            userId,
            await hoistConnectionData(data, hoist),
            options,
          );
      }
      if (prop === "update") {
        return async (
          id: string,
          userId: string,
          data: Parameters<VirtualMCPStoragePort["update"]>[2],
        ) => target.update(id, userId, await hoistConnectionData(data, hoist));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Hoist inline `data:` media out of a single message's `parts` and `metadata`. */
async function hoistMessage<M extends ThreadMessage>(
  m: M,
  hoist: AssetHoister,
): Promise<M> {
  return {
    ...m,
    parts: (await hoistDeep(m.parts, hoist)) as ThreadMessage["parts"],
    metadata: (await hoistDeep(m.metadata, hoist)) as ThreadMessage["metadata"],
  };
}

type ListMessagesResult = { messages: ThreadMessage[]; total: number };

/**
 * Decorate a thread storage so inline `data:` media is hoisted out of message
 * `parts` (and `metadata`) on BOTH directions:
 * - `saveMessages` (write sink): neutralizes content re-inlined from tool
 *   results — e.g. `COLLECTION_THREAD_MESSAGES_LIST` echoing a bloated thread,
 *   or `*_LIST` icons — so base64 never lands in `thread_messages.parts`.
 * - `listMessages` (read sink): lazily cleans rows that predate the write sink
 *   (or were written through a path that bypassed it), so legacy base64 never
 *   re-enters LLM context / API responses. Upload is content-addressed, so a
 *   repeated read of the same legacy row is idempotent (overwrites identical
 *   bytes); the DB row itself is rewritten on its next save.
 */
export function withThreadMessageHoisting<
  T extends {
    saveMessages: (
      data: ThreadMessage[],
      organizationId: string,
    ) => Promise<void>;
    listMessages: (...args: never[]) => Promise<ListMessagesResult>;
  },
>(base: T, hoist: AssetHoister): T {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "saveMessages") {
        return async (data: ThreadMessage[], organizationId: string) => {
          const hoisted = await Promise.all(
            data.map((m) => hoistMessage(m, hoist)),
          );
          return target.saveMessages(hoisted, organizationId);
        };
      }
      if (prop === "listMessages") {
        return async (...args: never[]) => {
          const result = await target.listMessages(...args);
          const messages = await Promise.all(
            result.messages.map((m) => hoistMessage(m, hoist)),
          );
          return { ...result, messages };
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
