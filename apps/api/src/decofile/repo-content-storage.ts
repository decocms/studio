/**
 * The read side of the content protocol over a project's Git repository: the
 * file list, file bodies and schema of one branch. The hosted v8
 * editor (`hosted/draft-content-storage.ts`) reads the default branch through
 * it and layers the CDN draft on top; nothing here writes.
 *
 * Versions are git blob shas and the revision is the branch head sha. A
 * missing branch reads as the default branch (reported in `resolvedRef`).
 */

import {
  type ContentStorage,
  type StorageSnapshot,
  type StoredFileBody,
  type StoredSchema,
  StorageNotFoundError,
  StorageUnavailableError,
} from "@decocms/blocks/protocol";
import { isV8SchemaText, schemaGenPath } from "@decocms/shared/blocks-major";
import {
  type RepoContentClient,
  repoRateLimitRetryAfterMs,
  requireBranchHead,
} from "@/git-providers";
import {
  blockEntriesInTree,
  blocksDirPath,
  resolveBlockContents,
} from "./read-decofile";

/** What the hosted draft storage reads from the repository. */
export type RepoContentReader = Pick<
  ContentStorage,
  "snapshot" | "readFiles" | "readSchema"
> & {
  /** The branch head (`snapshot`'s revision) and the branch actually read. */
  head(): Promise<{ sha: string; ref: string }>;
  /** The saved-block files at one commit; `readFiles` reads them as usual. */
  snapshotAt(sha: string, ref: string): Promise<StorageSnapshot>;
  /** `readSchema` for a head already read (`head()` or a snapshot's). */
  readSchemaAt(head: {
    sha: string;
    ref: string;
  }): Promise<StoredSchema | null>;
};

interface RepoContentStorageOptions {
  client: RepoContentClient;
  /** The app root inside the repository; `null` at the repository root. */
  packagePath: string | null;
  /** The one branch this storage reads. */
  branch: string;
}

/** Turns provider failures into the storage errors the core understands. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const retryAfterMs = repoRateLimitRetryAfterMs(error);
    if (retryAfterMs !== undefined) {
      throw new StorageUnavailableError(
        "the Git provider is rate-limiting this repository",
        retryAfterMs ?? undefined,
      );
    }
    throw error;
  }
}

export function createRepoContentReader(
  options: RepoContentStorageOptions,
): RepoContentReader {
  const { client, packagePath, branch } = options;
  const blocksPrefix = `${blocksDirPath(packagePath)}/`;

  /** The bound branch's head, or the default branch's while it doesn't exist. */
  const readHead = async (): Promise<{ sha: string; ref: string }> => {
    const head = await client.getBranch(branch);
    if (head) return { sha: head.sha, ref: branch };
    const defaultBranch = await client.getDefaultBranch();
    return {
      sha: await requireBranchHead(client, defaultBranch),
      ref: defaultBranch,
    };
  };

  /** `.deco/schema.gen.json` at one commit (`schemaGenPath`). */
  const schemaEntryAt = async (sha: string) => {
    const path = schemaGenPath(packagePath);
    const entry = (await client.getEntriesAtPaths(sha, [path])).get(path);
    return entry?.type === "blob" ? entry : null;
  };

  /** The schema the bound branch sees, falling back to the default branch's. */
  const resolveSchema = async (head: { sha: string; ref: string }) => {
    const entry = await schemaEntryAt(head.sha);
    if (entry) return { entry, ref: head.ref };
    const defaultBranch = await client.getDefaultBranch();
    if (defaultBranch === head.ref) return null;
    const fallback = await schemaEntryAt(
      await requireBranchHead(client, defaultBranch),
    );
    return fallback ? { entry: fallback, ref: defaultBranch } : null;
  };

  const readBlobText = async (stem: string, sha: string): Promise<string> => {
    const [file] = await resolveBlockContents(client, [{ stem, sha }]);
    return file!.content;
  };

  const schemaOf = async (head: {
    sha: string;
    ref: string;
  }): Promise<StoredSchema | null> => {
    const schema = await resolveSchema(head);
    if (!schema) return null;
    const text = await readBlobText(schema.entry.path, schema.entry.sha);
    // A v7 site reads as schemaless, so the editor stays on the classic one.
    if (!isV8SchemaText(text)) return null;
    return { version: schema.entry.sha, text, resolvedRef: schema.ref };
  };

  /** The saved-block files of one commit's tree. */
  const filesAt = async (sha: string) => {
    const tree = await client.listDecofileEntries(sha, packagePath);
    const files = blockEntriesInTree(tree, packagePath).map((entry) => ({
      file: entry.path.slice(blocksPrefix.length),
      version: entry.sha,
      size: entry.size,
    }));
    return { tree, files };
  };

  return {
    head: () => guarded(readHead),

    snapshot: () =>
      guarded(async (): Promise<StorageSnapshot> => {
        const head = await readHead();
        const { tree, files } = await filesAt(head.sha);
        if (tree.length === 0 && (await schemaEntryAt(head.sha)) === null) {
          throw new StorageNotFoundError(
            `no .deco folder in ${packagePath ?? "the repository root"}`,
          );
        }
        return { revision: head.sha, resolvedRef: head.ref, files };
      }),

    snapshotAt: (sha, ref) =>
      guarded(async (): Promise<StorageSnapshot> => {
        const { files } = await filesAt(sha);
        return { revision: sha, resolvedRef: ref, files };
      }),

    readFiles: (snapshot, files) =>
      guarded(async () => {
        const wanted = new Set(files);
        const sources = snapshot.files.filter((f) => wanted.has(f.file));
        // A snapshot is a commit, so the bytes always match its versions.
        const contents = await resolveBlockContents(
          client,
          sources.map((f) => ({ stem: f.file, sha: f.version })),
        );
        const out: Record<string, StoredFileBody> = {};
        sources.forEach((f, i) => {
          out[f.file] = { text: contents[i]!.content, version: f.version };
        });
        return out;
      }),

    readSchema: () => guarded(async () => schemaOf(await readHead())),

    readSchemaAt: (head) => guarded(() => schemaOf(head)),
  };
}
