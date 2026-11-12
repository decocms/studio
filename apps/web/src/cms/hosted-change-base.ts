import { spellingKey } from "@decocms/blocks/protocol";
import type { ContentChanges } from "./content-changes";
import type { ContentIndex } from "./hosted-content";

/** The published base of a change, including blocks whose bodies never loaded. */
export function hostedChangeBase(
  name: string,
  index: ContentIndex | undefined,
  listed: ContentChanges | undefined,
  loadedVersions: Readonly<Record<string, string>> | undefined,
): string | null {
  const spelling = spellingKey(name);
  const changeName = Object.keys(listed?.changes ?? {}).find(
    (key) => spellingKey(key) === spelling,
  );
  if (changeName !== undefined && listed)
    return listed.changes[changeName]!.baseVersion;
  const inDraft = Object.keys(index?.draft ?? {}).some(
    (key) => spellingKey(key) === spelling,
  );
  if (index && !inDraft) {
    const publishedName = Object.keys(index.entries).find(
      (key) => spellingKey(key) === spelling,
    );
    return publishedName === undefined
      ? null
      : index.entries[publishedName]!.version;
  }
  return loadedVersions?.[name] ?? null;
}
