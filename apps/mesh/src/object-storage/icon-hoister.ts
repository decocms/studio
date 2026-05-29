/**
 * Icon hoisting
 *
 * Connection/virtual-MCP icons can arrive as inline `data:` base64 images (app
 * favicons from the registry, AI-generated brand icons, etc.). They live in two
 * places on the `connections` row: the top-level `icon` column AND nested inside
 * the JSON `metadata` column (e.g. `metadata.ui.icon`). Persisted verbatim, they
 * get re-inlined into every `COLLECTION_*_LIST` result, which the agent
 * serializes into `thread_messages.parts` — bloating threads by hundreds of
 * KB–MB per call and overflowing NATS/LLM limits.
 *
 * The hoister uploads the bytes to object storage once and stores a directly
 * loadable files URL instead. It returns `${baseUrl}/api/${orgSlug}/files/${key}`
 * — NOT a `mesh-storage://` URI — because connection/agent-icon rendering loads
 * the value as a raw `<img src>` and does not resolve the mesh-storage scheme.
 *
 * Applied as a per-request decorator on `storage.connections`/`storage.virtualMcps`
 * in the context factory, where `ctx.objectStorage` and the org slug exist (the
 * base storage classes are singletons and have neither). Only `data:image/*`
 * values are touched; other strings (and non-image data: URIs) pass through.
 */

import type { BoundObjectStorage } from "./bound-object-storage";
import type {
  ConnectionStoragePort,
  VirtualMCPStoragePort,
} from "../storage/ports";

const DATA_IMAGE = /^data:(image\/[^;]+);base64,(.+)$/s;
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

export type IconHoister = (
  value: string | null | undefined,
) => Promise<string | null | undefined>;

export function createIconHoister(deps: {
  objectStorage: BoundObjectStorage | null;
  baseUrl: string;
  orgSlug: string | undefined;
}): IconHoister {
  const { objectStorage, baseUrl, orgSlug } = deps;
  return async (value) => {
    if (typeof value !== "string") return value;
    const match = value.match(DATA_IMAGE);
    if (!match) return value; // already a URL / not a data: image
    if (!objectStorage || !orgSlug) return value; // no storage → leave as-is
    const [, mimeType, b64] = match;
    const key = `connection-icons/${crypto.randomUUID()}.${
      EXT_BY_MIME[mimeType!] ?? "bin"
    }`;
    try {
      await objectStorage.put(key, Buffer.from(b64!, "base64"), {
        contentType: mimeType,
      });
      return `${baseUrl}/api/${orgSlug}/files/${key}`;
    } catch (err) {
      console.error("[icon-hoister] upload failed, keeping inline icon:", err);
      return value;
    }
  };
}

/** Recursively replace every inline `data:image` string in a JSON value. */
async function hoistDeep(value: unknown, hoist: IconHoister): Promise<unknown> {
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
 * Hoist inline icons on a connection-shaped payload: the top-level `icon`
 * field and any `data:image` nested in the `metadata` object (e.g.
 * `metadata.ui.icon`). Returns a shallow copy with those fields replaced.
 */
async function hoistConnectionData<
  D extends { icon?: string | null; metadata?: unknown },
>(data: D, hoist: IconHoister): Promise<D> {
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
 * Decorate a ConnectionStoragePort so create/update hoist inline `data:image`
 * icons (in `icon` and `metadata`) before persisting. Other methods pass
 * through untouched.
 */
export function withConnectionIconHoisting<T extends ConnectionStoragePort>(
  base: T,
  hoist: IconHoister,
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
 * Decorate a VirtualMCPStoragePort so create/update hoist inline `data:image`
 * icons (in `icon` and `metadata`).
 */
export function withVirtualMcpIconHoisting<T extends VirtualMCPStoragePort>(
  base: T,
  hoist: IconHoister,
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
        ) =>
          target.update(id, userId, await hoistConnectionData(data, hoist));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
