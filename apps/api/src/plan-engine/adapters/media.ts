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

/** `storage` is the run's org-bound storage: the org id is already in every key. */
export function orgMediaStore(storage: BoundObjectStorage): MediaStore {
  const key = (path: string) => {
    const clean = path.replace(/^\/+/, "");
    if (!clean || clean.split("/").some((s) => s === ".." || s === "")) {
      throw new Error(`invalid media path: ${path}`);
    }
    return `${PREFIX}/${clean}`;
  };
  return {
    async put(path, bytes, contentType) {
      await storage.put(key(path), bytes, { contentType });
      return path;
    },
    async get(path) {
      try {
        return await storage.getBytes(key(path));
      } catch (err) {
        if (isMissingObject(err)) return null;
        throw err;
      }
    },
    url: (path) => storage.presignedGetUrl(key(path), URL_TTL_SECONDS),
  };
}
