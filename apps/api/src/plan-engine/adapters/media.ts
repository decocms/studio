/**
 * The engine's media (captures, mockups, repository snapshots) in the org's
 * object storage, under one prefix so it never mixes with the org's files.
 */

import type { BoundObjectStorage } from "@/object-storage/bound-object-storage";
import { isMissingObject } from "@/file-storage/org-fs";
import type { MediaStore } from "../ports.ts";

const PREFIX = "plan-engine";
/** Long enough for a model call to fetch the image, short enough to not leak. */
const URL_TTL_SECONDS = 15 * 60;
/** How long an image URL the Plan page receives stays valid. */
const VIEW_TTL_SECONDS = 60 * 60;
/** Signatures start at the last multiple of this, so polls get the same URL and the browser keeps the image. */
const VIEW_BUCKET_SECONDS = 10 * 60;

/** An image the engine saved: `ux/…` with an image extension (`MediaStore.put` paths). */
const MEDIA_PATH = /^ux\/[^\s?#\\]+\.(?:jpe?g|png|webp)$/;

function mediaKey(path: string): string {
  const clean = path.replace(/^\/+/, "");
  if (!clean || clean.split("/").some((s) => s === ".." || s === "")) {
    throw new Error(`invalid media path: ${path}`);
  }
  return `${PREFIX}/${clean}`;
}

/** `storage` is the run's org-bound storage: the org id is already in every key. */
export function orgMediaStore(storage: BoundObjectStorage): MediaStore {
  return {
    async put(path, bytes, contentType) {
      await storage.put(mediaKey(path), bytes, { contentType });
      return path;
    },
    async get(path) {
      try {
        return await storage.getBytes(mediaKey(path));
      } catch (err) {
        if (isMissingObject(err)) return null;
        throw err;
      }
    },
    url: (path) => storage.presignedGetUrl(mediaKey(path), URL_TTL_SECONDS),
  };
}

/** When a URL signed at `nowMs` starts and how long it lasts: at least VIEW_TTL_SECONDS from now. */
export function viewWindow(nowMs: number): {
  signedAt: Date;
  expiresIn: number;
} {
  const bucketMs = VIEW_BUCKET_SECONDS * 1000;
  return {
    signedAt: new Date(Math.floor(nowMs / bucketMs) * bucketMs),
    expiresIn: VIEW_TTL_SECONDS + VIEW_BUCKET_SECONDS,
  };
}

type Sign = (path: string) => Promise<string>;

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Presigns the org's media paths for the Plan page. */
export function mediaViewSigner(
  storage: BoundObjectStorage,
  now: () => number = Date.now,
): Sign {
  return async (path) => {
    const { signedAt, expiresIn } = viewWindow(now());
    return storage.presignedGetUrl(mediaKey(path), expiresIn, { signedAt });
  };
}

/**
 * `value` with every string that is an engine image path swapped for what
 * `sign` returns, wherever it sits; anything else stays as it was. A path
 * that fails to sign stays a path.
 */
export async function withMediaUrls<T>(value: T, sign: Sign): Promise<T> {
  const memo = new Map<string, Promise<string>>();
  const signOnce = (path: string) => {
    let url = memo.get(path);
    if (!url) {
      url = Promise.resolve()
        .then(() => sign(path))
        .catch(() => path);
      memo.set(path, url);
    }
    return url;
  };
  const walk = async (v: unknown): Promise<unknown> => {
    if (typeof v === "string") return MEDIA_PATH.test(v) ? signOnce(v) : v;
    if (Array.isArray(v)) return Promise.all(v.map(walk));
    if (isPlainObject(v)) {
      const entries = await Promise.all(
        Object.entries(v).map(async ([k, x]) => [k, await walk(x)] as const),
      );
      return Object.fromEntries(entries);
    }
    return v;
  };
  return (await walk(value)) as T;
}
