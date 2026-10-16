/**
 * Who made the other change a same-field conflict dialog shows, and when.
 *
 * A Fast Preview draft saves each change as a commit: Studio's history of
 * the block (`GET …/changed-by`) names the Studio member, or a developer's
 * git name. A sandbox working tree has no such history: nothing.
 *
 * Asked once per version of theirs the dialog shows (the query key carries
 * it), never per poll; a failure is "unknown", and the dialog then shows no
 * line at all.
 */

import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
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
  /** A local edit, at the file's modification time (Blocks v8 Localhost). */
  | { kind: "local"; at: string };

export type ConflictAuthorSource = {
  kind: "history";
  key: string;
  params: DecofileScopeParams;
} | null;

/** Where a conflict's author can be read: a Fast Preview session's history. */
export function conflictAuthorSource(
  fastPreview: boolean,
  params: DecofileScopeParams,
): ConflictAuthorSource {
  const key = `${params.orgSlug}/${params.virtualMcpId}/${params.branch}`;
  return fastPreview ? { kind: "history", key, params } : null;
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

async function readAuthor(
  source: NonNullable<ConflictAuthorSource>,
  blockKey: string,
): Promise<ConflictAuthor | null> {
  try {
    const changedBy = await fetchChangedBy(source.params, [blockKey]);
    return authorFromChangedBy(
      Object.hasOwn(changedBy, blockKey) ? changedBy[blockKey] : undefined,
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
