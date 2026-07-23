/**
 * Asset hoisting
 *
 * Inline `data:` base64 media (images, audio, video) can arrive on connection
 * and virtual-MCP icon write paths (app favicons from the registry,
 * AI-generated brand icons). Persisted verbatim, they get re-inlined into every
 * `COLLECTION_*_LIST` result — bloating payloads by hundreds of KB–MB per call
 * and overflowing NATS/LLM limits.
 *
 * The hoister uploads the bytes to object storage once and stores a directly
 * loadable files URL instead — `${baseUrl}/api/${orgSlug}/files/${key}`, NOT a
 * `studio-storage://` URI. The files URL is what icon/media rendering needs: the
 * UI loads the value as a raw `<img src>` / media src (same-origin, session
 * cookie) and does not resolve the studio-storage scheme.
 *
 * Applied as a per-request decorator on `storage.connections`/`storage.virtualMcps`
 * in the context factory, where `ctx.objectStorage` and the org slug exist (the
 * base storage classes are singletons and have neither). Only
 * `data:(image|audio|video)/*` values with a known-safe extension are touched;
 * other strings (and active/unknown media types like SVG) pass through.
 */

import { createHash } from "node:crypto";
import type { BoundObjectStorage } from "./bound-object-storage";
import { toFilesUrl } from "./key-utils";
import type {
  ConnectionStoragePort,
  VirtualMCPStoragePort,
} from "../storage/ports";

// Captures the media type (group 1, params stripped) and the base64 payload
// (group 2). Tolerates media-type parameters (e.g. `;charset=utf-8`) before
// `;base64` and is case-insensitive, since data: URIs are per RFC 2397.
const DATA_MEDIA =
  /^data:((?:image|audio|video)\/[^;,]+)(?:;[^,]+)?;base64,(.+)$/is;
/** Default cap on decoded asset size. Larger payloads stay inline rather than
 * decoded into a Buffer, so a pathological data: URI can't OOM the process. */
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
/** Recursion guard for `hoistDeep` — bail on pathologically deep/cyclic JSON
 * rather than overflowing the stack. */
const MAX_DEPTH = 64;
const ASSET_HOISTING_TARGET: unique symbol = Symbol("assetHoistingTarget");
/**
 * Known-safe media types we will hoist, mapped to file extension. SVG is
 * deliberately absent: it can carry script and is served inline same-origin by
 * the `/files/` route, so hoisting it would turn an icon into stored XSS. Any
 * media type not in this map stays inline (see `createAssetHoister`).
 */
const EXT_BY_MIME: Record<string, string> = {
  // image
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
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

export interface AssetHoistingDeps {
  objectStorage: BoundObjectStorage | null;
  baseUrl: string;
  orgSlug: string | undefined;
}

type AssetHoistingWrapped<T> = T & {
  [ASSET_HOISTING_TARGET]?: T;
};

function unwrapAssetHoisting<T>(value: T): T {
  let current = value as AssetHoistingWrapped<T>;
  while (current?.[ASSET_HOISTING_TARGET]) {
    current = current[ASSET_HOISTING_TARGET] as AssetHoistingWrapped<T>;
  }
  return current as T;
}

export function createAssetHoister(
  deps: AssetHoistingDeps & {
    /** Storage key prefix for uploaded assets. */
    prefix?: string;
    /** Max decoded asset size to hoist (bytes). Defaults to 5 MiB. */
    maxBytes?: number;
    /** When true, compute the would-be files URL without uploading. Used by
     * the backfill's --dry-run so it can report changes without S3 writes. */
    dryRun?: boolean;
  },
): AssetHoister {
  const {
    objectStorage,
    baseUrl,
    orgSlug,
    prefix = "connection-icons",
    maxBytes = MAX_ASSET_BYTES,
    dryRun = false,
  } = deps;
  return async (value) => {
    if (typeof value !== "string") return value;
    const match = value.match(DATA_MEDIA);
    if (!match) return value; // already a URL / not a data: media URI
    if (!objectStorage || !orgSlug) return value; // no storage → leave as-is
    const [, rawMime, b64] = match;
    const mimeType = rawMime!.toLowerCase();
    // Only hoist known-safe media types. Unknown/active types (e.g. SVG, which
    // can execute script when served inline) stay inline rather than becoming a
    // file URL with an attacker-controlled content-type.
    const ext = EXT_BY_MIME[mimeType];
    if (!ext) return value;
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
    const key = `${prefix}/${digest}.${ext}`;
    if (dryRun) return toFilesUrl(baseUrl, orgSlug, key);
    try {
      await objectStorage.put(key, bytes, {
        contentType: mimeType,
      });
      return toFilesUrl(baseUrl, orgSlug, key);
    } catch (err) {
      console.error(
        "[asset-hoister] upload failed, keeping inline asset:",
        err,
      );
      return value;
    }
  };
}

/**
 * Recursively replace every inline `data:` media string in a JSON value.
 * Returns the SAME reference when nothing changed, so callers can cheaply
 * detect whether a hoist actually touched the value. Object properties are
 * hoisted in parallel.
 */
async function hoistDeep(
  value: unknown,
  hoist: AssetHoister,
  depth = 0,
): Promise<unknown> {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === "string") return (await hoist(value)) ?? value;
  if (Array.isArray(value)) {
    const items = await Promise.all(
      value.map((item) => hoistDeep(item, hoist, depth + 1)),
    );
    return items.some((it, i) => it !== value[i]) ? items : value;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    const hoisted = await Promise.all(
      entries.map(([, v]) => hoistDeep(v, hoist, depth + 1)),
    );
    let changed = false;
    const out: Record<string, unknown> = {};
    entries.forEach(([k, v], i) => {
      out[k] = hoisted[i];
      if (hoisted[i] !== v) changed = true;
    });
    return changed ? out : value;
  }
  return value;
}

/**
 * Deep-hoist inline `data:` media in an arbitrary JSON value, returning the
 * SAME reference when nothing changed. Exposed so the one-off thread-asset
 * backfill (`deco backfill-thread-assets`) reuses the exact traversal +
 * hoisting logic as the live write sink — no duplicated regex/key/URL rules.
 */
export function hoistInlineAssets(
  value: unknown,
  hoist: AssetHoister,
): Promise<unknown> {
  return hoistDeep(value, hoist);
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
 * Decorate a ConnectionStoragePort so create/createNew/update hoist inline
 * `data:` media (in `icon` and `metadata`) before persisting. Other methods
 * pass through untouched.
 */
function withConnectionAssetHoisting<T extends ConnectionStoragePort>(
  base: T,
  hoist: AssetHoister,
): T {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === ASSET_HOISTING_TARGET) return target;
      if (prop === "create") {
        return async (data: Parameters<ConnectionStoragePort["create"]>[0]) =>
          target.create(await hoistConnectionData(data, hoist));
      }
      if (prop === "createNew") {
        return async (
          data: Parameters<ConnectionStoragePort["createNew"]>[0],
        ) => target.createNew(await hoistConnectionData(data, hoist));
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
function withVirtualMcpAssetHoisting<T extends VirtualMCPStoragePort>(
  base: T,
  hoist: AssetHoister,
): T {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === ASSET_HOISTING_TARGET) return target;
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

/**
 * Decorate connection and virtual-MCP storage in place so all inline `data:`
 * media is hoisted to object storage on write. Single wiring point shared by
 * the context factory; connection and virtual-MCP icons share one hoister
 * (default `connection-icons` prefix).
 */
export function decorateStorageWithAssetHoisting<
  S extends {
    connections: ConnectionStoragePort;
    virtualMcps: VirtualMCPStoragePort;
  },
>(storage: S, deps: AssetHoistingDeps): void {
  const iconHoister = createAssetHoister(deps);
  // Guard each port: some contexts (e.g. the resolve-org-from-path middleware
  // running against a partially-built context) carry only a subset of storage
  // ports. `new Proxy(undefined)` would throw, so only wrap real objects.
  if (isObject(storage.connections)) {
    storage.connections = withConnectionAssetHoisting(
      unwrapAssetHoisting(storage.connections),
      iconHoister,
    ) as S["connections"];
  }
  if (isObject(storage.virtualMcps)) {
    storage.virtualMcps = withVirtualMcpAssetHoisting(
      unwrapAssetHoisting(storage.virtualMcps),
      iconHoister,
    ) as S["virtualMcps"];
  }
}

function isObject(value: unknown): boolean {
  return value !== null && typeof value === "object";
}
