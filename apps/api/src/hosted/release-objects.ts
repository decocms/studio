/**
 * What a hosted release is made of, read from one commit of the site's repo.
 *
 * `blocks` is built exactly the way `deco content` builds the site's bundled
 * content (`readSavedBlocks` in @decocms/blocks): every `.deco/blocks/*.json`
 * file whose name is valid, resolved across spellings, parsed. `schemaHash`
 * is `sha256Hex(canonicalJson(JSON.parse(.deco/schema.gen.json)))`, the value
 * `deco content` writes into the site's content module: the SDK swaps to a
 * release only when the two match.
 */

import {
  blockNameFromFile,
  canonicalJson,
  checkBlockName,
  entryHasPath,
  isBlockFileName,
  resolveSpellings,
  sha256Hex,
} from "@decocms/blocks/protocol";
import { isV8SchemaText, schemaGenPath } from "@decocms/shared/blocks-major";
import type { RepoContentClient } from "@/git-providers";
import {
  type BlockSource,
  blockEntriesInTree,
  blocksDirPath,
  resolveBlockContents,
} from "@/decofile/read-decofile";

/** The commit has no Blocks v8 schema; nothing is published for it. */
export class NotV8Site extends Error {
  constructor() {
    super("not a Blocks v8 site (.deco/schema.gen.json isn't a v8 schema)");
    this.name = "NotV8Site";
  }
}

/** A saved block the site's own build would refuse. */
export class InvalidSavedBlock extends Error {
  constructor(file: string, reason: string) {
    super(`.deco/blocks/${file}: ${reason}`);
    this.name = "InvalidSavedBlock";
  }
}

export interface RevisionObject {
  revision: string;
  schemaHash: string;
  blocks: Record<string, Record<string, unknown>>;
}

/** The schemaHash of schema text, or null when it isn't a v8 schema. */
export async function schemaHashOfText(text: string): Promise<string | null> {
  if (!isV8SchemaText(text)) return null;
  return sha256Hex(canonicalJson(JSON.parse(text)));
}

/** The schemaHash at `sha`; throws {@link NotV8Site} when there is none. */
export async function schemaHashAt(
  client: RepoContentClient,
  packagePath: string | null,
  sha: string,
): Promise<string> {
  const text = await client.readFileAtRef(sha, schemaGenPath(packagePath));
  const hash = text === null ? null : await schemaHashOfText(text);
  if (!hash) throw new NotV8Site();
  return hash;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The schemaHash at `sha` read through the tree (`getEntriesAtPaths`) and the
 * blob cache: free when the same client just listed that commit's `.deco`
 * (its tree reads are memoized) and the schema's blob is cached.
 */
export async function schemaHashInTree(
  client: RepoContentClient,
  packagePath: string | null,
  sha: string,
): Promise<string> {
  const path = schemaGenPath(packagePath);
  const entry = (await client.getEntriesAtPaths(sha, [path])).get(path);
  if (entry?.type !== "blob") throw new NotV8Site();
  const [schema] = await resolveBlockContents(client, [
    { stem: path, sha: entry.sha },
  ]);
  const hash = await schemaHashOfText(schema!.content);
  if (!hash) throw new NotV8Site();
  return hash;
}

/** One `.deco/blocks` file of a commit: its name there and its content. */
export interface SavedBlockFile {
  /** The file name inside `.deco/blocks`, such as `pages-Home.json`. */
  file: string;
  source: BlockSource;
}

/** The saved blocks at `sha`, keyed by entry name. */
async function savedBlocksAt(
  client: RepoContentClient,
  packagePath: string | null,
  sha: string,
): Promise<Record<string, Record<string, unknown>>> {
  const prefix = `${blocksDirPath(packagePath)}/`;
  const tree = await client.listDecofileEntries(sha, packagePath);
  return savedBlocksOf(
    client,
    blockEntriesInTree(tree, packagePath).map((entry) => ({
      file: entry.path.slice(prefix.length),
      source: { stem: entry.stem, sha: entry.sha },
    })),
  );
}

/** The saved blocks of a commit's `.deco/blocks` files, keyed by entry name. */
async function savedBlocksOf(
  client: RepoContentClient,
  all: SavedBlockFile[],
  memo?: Map<string, string>,
): Promise<Record<string, Record<string, unknown>>> {
  const files = all.filter((f) => isBlockFileName(f.file));
  const contents = await resolveBlockContents(
    client,
    files.map((f) => f.source),
    memo,
  );
  const candidates = files.map((f, i) => {
    const [invalid] = checkBlockName(blockNameFromFile(f.file));
    if (invalid) {
      throw new InvalidSavedBlock(f.file, "not a valid entry name");
    }
    let entry: unknown;
    try {
      entry = JSON.parse(contents[i]!.content);
    } catch {
      throw new InvalidSavedBlock(f.file, "invalid JSON");
    }
    if (!isPlainObject(entry)) {
      throw new InvalidSavedBlock(
        f.file,
        "a saved block must be a JSON object",
      );
    }
    return { file: f.file, hasPath: entryHasPath(entry), entry };
  });
  const blocks: Record<string, Record<string, unknown>> = Object.create(null);
  for (const { name, winner } of resolveSpellings(candidates).values()) {
    blocks[name] = winner.entry;
  }
  return blocks;
}

/**
 * The revision object for commit `sha` from what its committer already
 * holds: the commit's block files (texts in hand, or blob shas read through
 * the blob cache) and its schemaHash. No tree read.
 */
export async function buildRevisionFrom(
  client: RepoContentClient,
  sha: string,
  known: {
    schemaHash: string;
    files: SavedBlockFile[];
    memo?: Map<string, string>;
  },
): Promise<RevisionObject> {
  return {
    revision: sha,
    schemaHash: known.schemaHash,
    blocks: await savedBlocksOf(client, known.files, known.memo),
  };
}

/** The revision object for commit `sha`. */
export async function buildRevision(
  client: RepoContentClient,
  packagePath: string | null,
  sha: string,
): Promise<RevisionObject> {
  const [schemaHash, blocks] = await Promise.all([
    schemaHashAt(client, packagePath, sha),
    savedBlocksAt(client, packagePath, sha),
  ]);
  return { revision: sha, schemaHash, blocks };
}
