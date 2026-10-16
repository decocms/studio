/**
 * Who made the other change a same-field conflict dialog shows, and when.
 *
 * - A Fast Preview draft (v7) and a hosted v8 draft: Studio's history of the
 *   block (`GET …/changed-by`): the Studio member, or a developer's git name.
 * - Localhost (`deco serve`): the protocol has no authors, and local edits are
 *   the developer's own; the file's modification time, when the server
 *   reports it (`changes.get` entries' optional `modifiedAt`), is shown as
 *   "on your computer".
 * - Anything else (a sandbox's working tree, an older `deco serve`): nothing.
 *
 * Asked once per version of theirs the dialog shows (the query key carries
 * it), never per poll; a failure is "unknown", and the dialog then shows no
 * line at all.
 */

import type { ContentClient } from "@decocms/blocks/protocol";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import type { ContentBackend } from "./content-backend";
import {
  type ChangedBy,
  type DecofileScopeParams,
  fetchChangedBy,
} from "./decofile-api";

export type ConflictAuthor =
  /** A person: the Studio member or a git name; neither when only the time is known. */
  | {
      kind: "person";
      name?: string;
      avatarUrl?: string;
      at: string;
      you: boolean;
    }
  /** A local edit (Localhost), at the file's modification time. */
  | { kind: "local"; at: string };

export type ConflictAuthorSource =
  | { kind: "history"; key: string; params: DecofileScopeParams }
  | { kind: "local"; key: string; client: ContentClient }
  | null;

/** Where a conflict's author can be read, for this editor's backend. */
export function conflictAuthorSource(
  backend: ContentBackend,
  fastPreview: boolean,
  params: DecofileScopeParams,
): ConflictAuthorSource {
  const key = `${params.orgSlug}/${params.virtualMcpId}/${params.branch}`;
  if (backend.kind === "legacy") {
    return fastPreview ? { kind: "history", key, params } : null;
  }
  if (backend.kind !== "protocol") return null;
  if (backend.source === "github") return { kind: "history", key, params };
  if (backend.source === "local") {
    return {
      kind: "local",
      key: `local:${key}${backend.cacheKeySuffix}`,
      client: backend.client,
    };
  }
  return null;
}

function validTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/** `changed-by`'s answer for one block, as the dialog shows it. */
export function authorFromChangedBy(
  changedBy: ChangedBy | undefined,
): ConflictAuthor | null {
  const at = validTime(changedBy?.at);
  if (!changedBy || !at) return null;
  const name = changedBy.name?.trim();
  return {
    kind: "person",
    ...(name ? { name } : {}),
    ...(changedBy.avatarUrl ? { avatarUrl: changedBy.avatarUrl } : {}),
    at,
    you: changedBy.you === true,
  };
}

/**
 * A `changes.get` entry's modification time. Optional in the protocol:
 * a server that doesn't report it answers nothing here.
 */
export function authorFromChangeEntry(entry: unknown): ConflictAuthor | null {
  const at = validTime((entry as { modifiedAt?: unknown } | null)?.modifiedAt);
  return at ? { kind: "local", at } : null;
}

async function readAuthor(
  source: NonNullable<ConflictAuthorSource>,
  blockKey: string,
): Promise<ConflictAuthor | null> {
  try {
    if (source.kind === "history") {
      const changedBy = await fetchChangedBy(source.params, [blockKey]);
      return authorFromChangedBy(
        Object.hasOwn(changedBy, blockKey) ? changedBy[blockKey] : undefined,
      );
    }
    const result = await source.client.call("changes.get", {
      names: [blockKey],
    });
    return authorFromChangeEntry(
      Object.hasOwn(result.entries, blockKey)
        ? result.entries[blockKey]
        : undefined,
    );
  } catch {
    return null;
  }
}

/** A short, stable tag for one version of theirs (part of the query key). */
export function versionTag(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = (Math.imul(h2, 31) + c) | 0;
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}:${text.length}`;
}

/**
 * Who made the change a conflict dialog shows. `theirs` identifies the
 * version shown: when it changes ("Their version changed again") the author
 * is read again. Null while unknown.
 */
export function useConflictAuthor(
  source: ConflictAuthorSource,
  blockKey: string | null,
  theirs: string | null,
): ConflictAuthor | null {
  const enabled = !!source && !!blockKey && theirs !== null;
  const { data } = useQuery({
    queryKey: KEYS.conflictAuthor(
      source?.key ?? "",
      blockKey ?? "",
      theirs ?? "",
    ),
    queryFn: () => readAuthor(source!, blockKey!),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return enabled ? (data ?? null) : null;
}
