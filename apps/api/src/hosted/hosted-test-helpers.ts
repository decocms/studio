/**
 * In-memory stand-ins for the hosted tests: a delivery bucket, the org KV and
 * a one-branch-plus-commits git repository behind `RepoContentClient`.
 */

import { createHash } from "node:crypto";
import type { RepoRef } from "@decocms/shared/git-providers";
import {
  type FileChange,
  type RepoContentClient,
  type RepoInsightsClient,
  RepoWriteConflict,
  type TreeEntry,
} from "@/git-providers";
import type { KVStorage } from "@/storage/kv";
import type { DeliveryPurge } from "./delivery-purge";
import type { DeliveryStore } from "./delivery-store";

export function memoryDeliveryStore() {
  const objects = new Map<
    string,
    { text: string; etag: string; cacheControl: string }
  >();
  const log: string[] = [];
  let n = 0;
  const store: DeliveryStore = {
    async putJson(key, value, cacheControl) {
      const etag = `"etag${++n}"`;
      objects.set(key, { text: JSON.stringify(value), etag, cacheControl });
      log.push(`put ${key}`);
      return { etag };
    },
    async get(key) {
      const o = objects.get(key);
      return o ? { text: o.text, etag: o.etag } : null;
    },
    async delete(key) {
      objects.delete(key);
      log.push(`delete ${key}`);
    },
    async listKeys(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
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

function blobSha(content: string): string {
  const bytes = Buffer.from(content, "utf-8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

const REPO: RepoRef = {
  provider: "github",
  host: "github.com",
  path: "acme/site",
};

/** A repository with one branch, `main`, whose commits are file maps. */
export function fakeRepo(files: Record<string, string>) {
  const blobs = new Map<string, string>();
  const commits = new Map<string, Map<string, string>>();
  const history: Array<{ sha: string; message: string }> = [];
  let head = "";
  let n = 0;
  const commit = (tree: Map<string, string>, message: string) => {
    const sha = createHash("sha1").update(`commit ${++n}`).digest("hex");
    for (const content of tree.values()) blobs.set(blobSha(content), content);
    commits.set(sha, tree);
    history.unshift({ sha, message });
    head = sha;
    return sha;
  };
  commit(new Map(Object.entries(files)), "initial");

  const treeAt = (ref: string) => {
    const tree = commits.get(ref === "main" ? head : ref);
    if (!tree) throw new Error(`no commit ${ref}`);
    return tree;
  };

  const client: RepoContentClient = {
    repo: REPO,
    getDefaultBranch: async () => "main",
    getBranch: async (branch) => (branch === "main" ? { sha: head } : null),
    searchBranches: async () => ({
      branches: [],
      totalCount: 0,
      nextCursor: null,
    }),
    getArchive: async () => null,
    listDecofileEntries: async (treeish, packagePath) => {
      const prefix = packagePath ? `${packagePath}/.deco/` : ".deco/";
      return [...treeAt(treeish)]
        .filter(([path]) => path.startsWith(prefix))
        .map(
          ([path, content]): TreeEntry => ({
            path,
            sha: blobSha(content),
            type: "blob",
            size: Buffer.byteLength(content),
          }),
        );
    },
    getEntriesAtPaths: async (treeish, paths) => {
      const tree = treeAt(treeish);
      return new Map(
        paths.flatMap((path) => {
          const content = tree.get(path);
          return content === undefined
            ? []
            : [[path, { path, sha: blobSha(content), type: "blob" as const }]];
        }),
      );
    },
    readBlob: async (sha) => {
      const content = blobs.get(sha);
      if (content === undefined) throw new Error(`no blob ${sha}`);
      return content;
    },
    readFileAtRef: async (ref, path) => treeAt(ref).get(path) ?? null,
    commitFiles: async ({ branch, message, expectedHead, changes }) => {
      if (branch !== "main") throw new Error("only main");
      if (expectedHead !== null && expectedHead !== head) {
        throw new RepoWriteConflict("head moved");
      }
      const tree = new Map(treeAt(head));
      for (const change of changes as FileChange[]) {
        if ("deleted" in change) tree.delete(change.path);
        else if ("content" in change) tree.set(change.path, change.content);
      }
      return { sha: commit(tree, message) };
    },
    createBranch: async () => {},
    forceBranchHead: async () => {},
    mergeBranches: async () => null,
    createChangeRequest: async () => {
      throw new Error("unused");
    },
    findOpenChangeRequest: async () => null,
    compare: async () => ({ aheadBy: 0, behindBy: 0 }),
    compareDetailed: async () => {
      throw new Error("unused");
    },
  };

  return {
    client,
    head: () => head,
    history,
    filesAt: (ref: string) => Object.fromEntries(treeAt(ref)),
    /** A commit made behind Studio's back (another writer). */
    pushDirect: (
      changes: Record<string, string | null>,
      message = "direct",
    ) => {
      const tree = new Map(treeAt(head));
      for (const [path, content] of Object.entries(changes)) {
        if (content === null) tree.delete(path);
        else tree.set(path, content);
      }
      return commit(tree, message);
    },
  };
}

/** `listCommits` over a fake repo's history, paged by offset; counts calls. */
export function fakeInsights(
  history: ReadonlyArray<{ sha: string; message: string }>,
) {
  const calls: Array<{ cursor: string | null; limit: number }> = [];
  const client = {
    listCommits: async ({
      cursor,
      limit = 50,
    }: {
      cursor?: string | null;
      limit?: number;
    }) => {
      calls.push({ cursor: cursor ?? null, limit });
      const from = cursor ? Number(cursor) : 0;
      const items = history.slice(from, from + limit).map((c, i) => ({
        sha: c.sha,
        date: new Date(
          Date.UTC(2026, 0, 1) - (from + i) * 60_000,
        ).toISOString(),
        message: c.message,
        author: { name: "Ana", email: null, login: null },
      }));
      return {
        items,
        nextCursor: from + limit < history.length ? String(from + limit) : null,
      };
    },
  } as unknown as RepoInsightsClient;
  return { client, calls };
}

/** The schemaHash test vector shared with @decocms/blocks `deco content`. */
export const SCHEMA_TEXT =
  '{\n  "version": "8.1.0-next.7",\n  "blocksMajor": 8,\n  "definitions": { "seo": { "type": "object", "title": "Seo" } },\n  "root": {}\n}\n';
export const SCHEMA_HASH =
  "00b083655ee7af02aa92dbff85e402857bb1e50c253a579dbab23498a7842c98";
