/**
 * In-memory stand-ins for the hosted tests: a delivery bucket and the org KV.
 */

import type { KVStorage } from "@/storage/kv";
import type { DeliveryPurge } from "./delivery-purge";
import {
  type DeliveryStore,
  ObjectChangedError,
  type PutCondition,
} from "./delivery-store";

export function memoryDeliveryStore() {
  const objects = new Map<
    string,
    { text: string; etag: string; cacheControl: string }
  >();
  const log: string[] = [];
  let n = 0;
  /** Runs before each write: a test throws here (an R2 429, a crash). */
  const hooks: {
    beforePut?: (key: string, condition: PutCondition | undefined) => void;
  } = {};
  const put = (
    key: string,
    text: string,
    cacheControl: string,
    condition: PutCondition | undefined,
  ) => {
    hooks.beforePut?.(key, condition);
    // Conditional writes as R2 checks them: against the object right now.
    const current = objects.get(key);
    if (
      condition &&
      ("ifMatch" in condition
        ? current?.etag !== condition.ifMatch
        : current !== undefined)
    ) {
      log.push(`refused ${key}`);
      throw new ObjectChangedError(key);
    }
    const etag = `"etag${++n}"`;
    objects.set(key, { text, etag, cacheControl });
    log.push(`put ${key}`);
    return { etag };
  };
  const store: DeliveryStore = {
    async putText(key, text, cacheControl, condition) {
      return put(key, text, cacheControl, condition);
    },
    async listPage(prefix, { maxKeys, continuationToken }) {
      const folders = [
        ...new Set(
          [...objects.keys()]
            .filter(
              (k) => k.startsWith(prefix) && k.indexOf("/", prefix.length) > 0,
            )
            .map((k) => k.slice(0, k.indexOf("/", prefix.length) + 1)),
        ),
      ].sort();
      const start = continuationToken ? Number(continuationToken) : 0;
      const prefixes = folders.slice(start, start + maxKeys);
      const next = start + maxKeys;
      return {
        prefixes,
        nextToken: next < folders.length ? String(next) : null,
      };
    },
    async putJson(key, value, cacheControl, condition) {
      return put(key, JSON.stringify(value), cacheControl, condition);
    },
    async get(key) {
      const o = objects.get(key);
      return o ? { text: o.text, etag: o.etag } : null;
    },
    async delete(key) {
      objects.delete(key);
      log.push(`delete ${key}`);
    },
  };
  /** Logs `purge <key>` into the same log; `failPurge` makes it throw. */
  const purgeState = { fail: false };
  const purge: DeliveryPurge = {
    async purge(key) {
      log.push(`purge ${key}`);
      if (purgeState.fail) throw new Error("purge failed");
    },
  };
  return {
    store,
    objects,
    log,
    hooks,
    purge,
    failPurge: (fail: boolean) => {
      purgeState.fail = fail;
    },
  };
}

export function memoryKv(): KVStorage {
  const data = new Map<string, Record<string, unknown>>();
  return {
    get: async (org, key) => data.get(`${org}\0${key}`) ?? null,
    set: async (org, key, value) => {
      data.set(`${org}\0${key}`, structuredClone(value));
    },
    delete: async (org, key) => {
      data.delete(`${org}\0${key}`);
    },
  };
}

/** A Blocks v8 schema (`"blocksMajor": 8`). */
export const SCHEMA_TEXT =
  '{\n  "version": "8.1.0-next.7",\n  "blocksMajor": 8,\n  "definitions": { "seo": { "type": "object", "title": "Seo" } },\n  "root": {}\n}\n';
