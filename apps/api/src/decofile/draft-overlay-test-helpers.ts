/** Fakes for draft overlay tests: a repository by commit, and object storage in memory. */
import type { RepoContentClient, TreeEntry } from "@/git-providers";
import type { BoundObjectStorage } from "../object-storage/bound-object-storage";
import { gitBlobSha } from "./read-decofile";

/** Saved-block files by name, per commit. */
type Commit = Record<string, string>;

/** A repository whose commits are listed by sha; `merge base` is fixed per test. */
export function fakeRepo(input: {
  commits: Record<string, Commit>;
  mergeBase: string;
  packagePath?: string;
}) {
  const blobs = new Map<string, string>();
  const reads: string[] = [];
  const prefix = input.packagePath
    ? `${input.packagePath}/.deco/blocks/`
    : ".deco/blocks/";
  const client = {
    repo: { provider: "github", host: "github.com", path: "acme/site" },
    getDefaultBranch: async () => "main",
    compareDetailed: async () => ({
      aheadBy: 1,
      behindBy: 0,
      mergeBaseSha: input.mergeBase,
      files: [],
      commitMessages: [],
    }),
    listDecofileEntries: async (treeish: string): Promise<TreeEntry[]> => {
      const commit = input.commits[treeish];
      if (!commit) throw new Error(`unknown commit ${treeish}`);
      return Object.entries(commit).map(([file, content]) => {
        const sha = gitBlobSha(content);
        blobs.set(sha, content);
        return { path: `${prefix}${file}`, type: "blob", sha };
      });
    },
    readBlob: async (sha: string) => {
      reads.push(sha);
      const content = blobs.get(sha);
      if (content === undefined) throw new Error(`unknown blob ${sha}`);
      return content;
    },
  } as unknown as RepoContentClient;
  return { client, reads };
}

/** Object storage in memory, recording the order of writes. */
export function memoryStorage() {
  const objects = new Map<string, string>();
  const puts: string[] = [];
  const store = {
    put: async (key: string, body: string | Uint8Array) => {
      puts.push(key);
      objects.set(
        key,
        typeof body === "string" ? body : new TextDecoder().decode(body),
      );
      return { key, etag: "" };
    },
    getBytes: async (key: string) => {
      const body = objects.get(key);
      if (body === undefined) {
        throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      }
      return new TextEncoder().encode(body);
    },
  } as unknown as BoundObjectStorage;
  return { store, objects, puts };
}
