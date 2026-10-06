/** A fake repository for draft-changes tests: branches named after their commits. */
import type { RepoContentClient, TreeEntry } from "@/git-providers";
import { gitBlobSha } from "./read-decofile";

/** Saved-block files by name, per commit. */
type Commit = Record<string, string>;

/**
 * A repository whose commits are listed by sha; each commit is also a branch
 * of the same name, and the merge base is fixed per test.
 */
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
    getBranch: async (name: string) =>
      input.commits[name] ? { sha: name } : null,
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
