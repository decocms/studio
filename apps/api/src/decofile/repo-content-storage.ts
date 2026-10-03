/**
 * The content protocol's storage over a project's Git repository: the site
 * editor's GitHub backend (the hosted side of `deco serve`).
 *
 * One storage is bound to one `(repository, app root, branch)`. The vendored
 * protocol core (`createContentHandler`) owns names, validation, the secret
 * guard, limits and retries; this file only lists, reads and commits files
 * under `<root>/.deco/`, through the same `RepoContentClient`, blob cache and
 * compare-and-swap commit the legacy decofile routes use.
 *
 * Versions are git blob shas and the revision is the branch head sha. Before
 * the first write a missing branch reads as the default branch (reported in
 * `resolvedRef`); the first commit creates it at the head it was read from.
 */

import type { CoAuthorIdentity } from "@decocms/sandbox/shared";
import {
  blockNameFromFile,
  type CommitResult,
  type ContentStorage,
  type StorageDescription,
  type StorageSnapshot,
  type StoredFileBody,
  type StoredSchema,
  StorageNotFoundError,
  StorageUnavailableError,
  unsupported,
} from "@decocms/shared/blocks-protocol";
import {
  type FileChange,
  type RepoContentClient,
  RepoWriteConflict,
  repoRateLimitRetryAfterMs,
  requireBranchHead,
} from "@/git-providers";
import { decofileCommitMessage, regenerateGenArtifact } from "./gen-artifact";
import {
  type BlockSource,
  blockEntriesInTree,
  blocksDirPath,
  gitBlobSha,
  primeBlobCache,
  resolveBlockContents,
} from "./read-decofile";

export interface RepoContentStorageOptions {
  client: RepoContentClient;
  /** The app root inside the repository; `null` at the repository root. */
  packagePath: string | null;
  /** The one branch this storage reads and writes. */
  branch: string;
  /** Acting user, appended as a `Co-authored-by:` trailer when present. */
  coAuthor?: CoAuthorIdentity | null;
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

export function createRepoContentStorage(
  options: RepoContentStorageOptions,
): ContentStorage {
  const { client, packagePath, branch } = options;
  const blocksPrefix = `${blocksDirPath(packagePath)}/`;

  const checkRef = (ref: string | undefined) => {
    if (ref !== undefined && ref !== branch) {
      throw unsupported(
        `this endpoint is bound to the branch "${branch}"; omit ref`,
      );
    }
  };

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
    describe(): StorageDescription {
      return {
        kind: "git",
        root: packagePath ?? ".",
        readOnly: false,
        refs: { default: branch, autoCreate: true },
        // Uploads go to Studio's own file storage, never into the repository.
        assets: null,
        idempotency: null,
      };
    },

    snapshot: ({ ref }) =>
      guarded(async (): Promise<StorageSnapshot> => {
        checkRef(ref);
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

    readSchema: ({ ref }) =>
      guarded(async (): Promise<StoredSchema | null> => {
        checkRef(ref);
        const schema = await resolveSchema(await readHead());
        if (!schema) return null;
        return {
          version: schema.entry.sha,
          text: await readBlobText(schema.entry.path, schema.entry.sha),
          resolvedRef: schema.ref,
        };
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

    commit: (attempt) =>
      guarded(async (): Promise<CommitResult> => {
        checkRef(attempt.ref);
        const base = attempt.base.revision;
        try {
          // The whole head is the guard: any commit since `base` is stale,
          // which covers every per-file expectation the core asks for.
          const current = await client.getBranch(branch);
          if (current === null) {
            await client.createBranch(branch, base);
          } else if (current.sha !== base) {
            return { status: "stale" };
          }
          if (attempt.expectedSchemaVersion !== undefined) {
            const schema = await resolveSchema({ sha: base, ref: branch });
            if ((schema?.entry.sha ?? null) !== attempt.expectedSchemaVersion) {
              return { status: "stale" };
            }
          }

          const tree = await client.listDecofileEntries(base, packagePath);
          const present = new Set(attempt.base.files.map((f) => f.file));
          const nextBlocks = new Map<string, BlockSource>(
            blockEntriesInTree(tree, packagePath).map((e) => [
              e.path,
              { stem: e.stem, sha: e.sha },
            ]),
          );
          const changes: FileChange[] = [];
          const versions: Record<string, string> = {};
          for (const [file, content] of Object.entries(attempt.put)) {
            const path = `${blocksPrefix}${file}`;
            changes.push({ path, content });
            nextBlocks.set(path, {
              stem: file.slice(0, -".json".length),
              content,
            });
            versions[file] = gitBlobSha(content);
            await primeBlobCache(client.repo, content);
          }
          for (const file of attempt.delete) {
            if (!present.has(file)) continue;
            const path = `${blocksPrefix}${file}`;
            changes.push({ path, deleted: true });
            nextBlocks.delete(path);
          }
          if (changes.length === 0) {
            return { status: "committed", revision: base, versions };
          }
          const gen = await regenerateGenArtifact({
            client,
            tree,
            packagePath,
            branch,
            nextBlocks: nextBlocks.values(),
            memo: new Map(),
          });
          if (gen) changes.push(gen);

          const { sha } = await client.commitFiles({
            branch,
            message: decofileCommitMessage(
              Object.keys(attempt.put).map(blockNameFromFile),
              attempt.delete.map(blockNameFromFile),
              options.coAuthor,
            ),
            expectedHead: base,
            changes,
          });
          return { status: "committed", revision: sha, versions };
        } catch (error) {
          if (error instanceof RepoWriteConflict) return { status: "stale" };
          throw error;
        }
      }),
  };
}
