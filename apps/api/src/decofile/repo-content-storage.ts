/**
 * The read side of the content protocol over a project's Git repository: the
 * file list, file bodies, schema and secrets key of one branch. The hosted v8
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
  "snapshot" | "readFiles" | "readSchema" | "readSecretsPublicKey"
>;

interface RepoContentStorageOptions {
  client: RepoContentClient;
  /** The app root inside the repository; `null` at the repository root. */
  packagePath: string | null;
  /** The one branch this storage reads. */
  branch: string;
}

/**
 * Whether committed schema text is a Blocks v8 one: only a top-level
 * `"blocksMajor": 8` (written by `deco schema`) counts. Missing, any other
 * value or unparseable text is a v7 site, which this protocol never serves.
 * Mirrors the web's `isV8Schema`.
 */
function isV8SchemaText(text: string): boolean {
  try {
    const schema: unknown = JSON.parse(text);
    return (
      typeof schema === "object" &&
      schema !== null &&
      !Array.isArray(schema) &&
      (schema as { blocksMajor?: unknown }).blocksMajor === 8
    );
  } catch {
    return false;
  }
}

function decoPath(packagePath: string | null, file: string): string {
  return packagePath ? `${packagePath}/.deco/${file}` : `.deco/${file}`;
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

  /** `schema.gen.json`, else `meta.gen.json`, at one commit. */
  const schemaEntryAt = async (sha: string) => {
    const paths = [
      decoPath(packagePath, "schema.gen.json"),
      decoPath(packagePath, "meta.gen.json"),
    ];
    const entries = await client.getEntriesAtPaths(sha, paths);
    for (const path of paths) {
      const entry = entries.get(path);
      if (entry?.type === "blob") return entry;
    }
    return null;
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

  return {
    snapshot: () =>
      guarded(async (): Promise<StorageSnapshot> => {
        const head = await readHead();
        const tree = await client.listDecofileEntries(head.sha, packagePath);
        if (tree.length === 0 && (await schemaEntryAt(head.sha)) === null) {
          throw new StorageNotFoundError(
            `no .deco folder in ${packagePath ?? "the repository root"}`,
          );
        }
        return {
          revision: head.sha,
          resolvedRef: head.ref,
          files: blockEntriesInTree(tree, packagePath).map((entry) => ({
            file: entry.path.slice(blocksPrefix.length),
            version: entry.sha,
            size: entry.size,
          })),
        };
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

    readSchema: () =>
      guarded(async (): Promise<StoredSchema | null> => {
        const schema = await resolveSchema(await readHead());
        if (!schema) return null;
        const text = await readBlobText(schema.entry.path, schema.entry.sha);
        // A v7 site reads as schemaless, so the editor stays on the classic one.
        if (!isV8SchemaText(text)) return null;
        return { version: schema.entry.sha, text, resolvedRef: schema.ref };
      }),

    readSecretsPublicKey: () =>
      guarded(async () => {
        const head = await readHead();
        const path = decoPath(packagePath, "secrets.pub");
        const entry = (await client.getEntriesAtPaths(head.sha, [path])).get(
          path,
        );
        return entry?.type === "blob"
          ? readBlobText(entry.path, entry.sha)
          : null;
      }),
  };
}
