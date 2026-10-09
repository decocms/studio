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
import type { RepoContentClient } from "@/git-providers";
import {
  blockEntriesInTree,
  blocksDirPath,
  resolveBlockContents,
} from "@/decofile/read-decofile";

/** The commit has no Blocks v8 schema; nothing is published for it. */
export class NotV8Site extends Error {
  constructor() {
    super("not a Blocks v8 site (.deco/schema.gen.json without blocksMajor 8)");
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

function schemaPath(packagePath: string | null): string {
  return packagePath
    ? `${packagePath}/.deco/schema.gen.json`
    : ".deco/schema.gen.json";
}

/** The schemaHash of schema text, or null when it isn't a v8 schema. */
export async function schemaHashOfText(text: string): Promise<string | null> {
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    typeof schema !== "object" ||
    schema === null ||
    Array.isArray(schema) ||
    (schema as { blocksMajor?: unknown }).blocksMajor !== 8
  ) {
    return null;
  }
  return sha256Hex(canonicalJson(schema));
}

/** The schemaHash at `sha`; throws {@link NotV8Site} when there is none. */
export async function schemaHashAt(
  client: RepoContentClient,
  packagePath: string | null,
  sha: string,
): Promise<string> {
  const text = await client.readFileAtRef(sha, schemaPath(packagePath));
  const hash = text === null ? null : await schemaHashOfText(text);
  if (!hash) throw new NotV8Site();
  return hash;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The saved blocks at `sha`, keyed by entry name. */
async function savedBlocksAt(
  client: RepoContentClient,
  packagePath: string | null,
  sha: string,
): Promise<Record<string, Record<string, unknown>>> {
  const prefix = `${blocksDirPath(packagePath)}/`;
  const tree = await client.listDecofileEntries(sha, packagePath);
  const files = blockEntriesInTree(tree, packagePath)
    .map((entry) => ({ file: entry.path.slice(prefix.length), sha: entry.sha }))
    .filter((f) => isBlockFileName(f.file));
  const contents = await resolveBlockContents(
    client,
    files.map((f) => ({ stem: f.file, sha: f.sha })),
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
