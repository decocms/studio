/**
 * Who made the other change a same-field conflict dialog shows, and when.
 *
 * - A Fast Preview draft (v7): Studio's history of the block
 *   (`GET …/changed-by`): the Studio member, or a developer's git name.
 * - A hosted v8 draft: the draft's own edits (the session read with
 *   `?edits=1`): a Studio user id and a time per name it holds, resolved to
 *   the member from the org's members (time only when the id isn't one). A
 *   name the draft doesn't hold is main's: `changed-by`, like v7.
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

import { type ContentClient, spellingKey } from "@decocms/blocks/protocol";
import { useQuery } from "@tanstack/react-query";
import { mainSchemaHeaders } from "@/hooks/main-schema-changed";
import { useMembersQuery } from "@/hooks/use-members";
import { authClient } from "@/lib/auth-client";
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

/** What a source answers: an author, or a Studio user id still to resolve. */
export type AuthorRecord =
  | ConflictAuthor
  | { kind: "member"; userId: string; at: string };

export type ConflictAuthorSource =
  | { kind: "history"; key: string; params: DecofileScopeParams }
  | { kind: "draft"; key: string; params: DecofileScopeParams }
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
  if (backend.source === "github") return { kind: "draft", key, params };
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

/** One draft edit (`{ userId, at }`) as the session read answers it. */
interface DraftEdit {
  userId: string;
  at: string;
}

/**
 * The draft's record for `blockKey`: `undefined` when the draft doesn't hold
 * it (main's history knows), `null` when it holds it without a record.
 */
export function draftEditFor(
  edits: Record<string, DraftEdit | null>,
  blockKey: string,
): DraftEdit | null | undefined {
  if (Object.hasOwn(edits, blockKey)) return edits[blockKey] ?? null;
  const key = spellingKey(blockKey);
  const name = Object.keys(edits).find((n) => spellingKey(n) === key);
  return name === undefined ? undefined : (edits[name] ?? null);
}

/** Who last changed each name a hosted v8 draft holds (the session read). */
async function fetchDraftEdits(
  params: DecofileScopeParams,
): Promise<Record<string, DraftEdit | null>> {
  const res = await fetch(
    `/api/${params.orgSlug}/decofile/${encodeURIComponent(params.virtualMcpId)}/${encodeURIComponent(params.branch)}?edits=1`,
    { cache: "no-store", headers: mainSchemaHeaders("v8") },
  );
  if (!res.ok) return {};
  const body = (await res.json().catch(() => ({}))) as {
    edits?: Record<string, DraftEdit | null>;
  };
  return body.edits ?? {};
}

async function readMainHistory(
  params: DecofileScopeParams,
  blockKey: string,
): Promise<AuthorRecord | null> {
  const changedBy = await fetchChangedBy(params, [blockKey]);
  return authorFromChangedBy(
    Object.hasOwn(changedBy, blockKey) ? changedBy[blockKey] : undefined,
  );
}

async function readAuthor(
  source: NonNullable<ConflictAuthorSource>,
  blockKey: string,
): Promise<AuthorRecord | null> {
  try {
    if (source.kind === "history") {
      return await readMainHistory(source.params, blockKey);
    }
    if (source.kind === "draft") {
      const edit = draftEditFor(await fetchDraftEdits(source.params), blockKey);
      if (edit === undefined)
        return await readMainHistory(source.params, blockKey);
      const at = validTime(edit?.at);
      return edit && at ? { kind: "member", userId: edit.userId, at } : null;
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

/** An org member, as the members list answers. */
export interface OrgMemberRow {
  userId: string;
  user?: { name?: string | null; image?: string | null } | null;
}

/**
 * A draft's user id as the dialog shows it: the member's name and avatar,
 * `you` for the viewer; only the time when the id isn't a member's.
 */
export function resolveMemberAuthor(
  record: AuthorRecord,
  members: readonly OrgMemberRow[],
  viewerId: string | null,
): ConflictAuthor {
  if (record.kind !== "member") return record;
  const you = !!viewerId && record.userId === viewerId;
  const member = members.find((m) => m.userId === record.userId);
  const name = member?.user?.name?.trim();
  const avatarUrl = member?.user?.image ?? undefined;
  return {
    kind: "person",
    ...(member && name ? { name } : {}),
    ...(member && avatarUrl ? { avatarUrl } : {}),
    at: record.at,
    you,
  };
}

/** The org's members (`useMembersQuery`'s cache), only while an id needs resolving. */
function useMembersFor(userId: string | null): readonly OrgMemberRow[] {
  const { data } = useMembersQuery({ enabled: !!userId });
  const members = (data as { data?: { members?: OrgMemberRow[] } } | undefined)
    ?.data?.members;
  return members ?? [];
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
  const record = enabled ? (data ?? null) : null;
  const members = useMembersFor(
    record?.kind === "member" ? record.userId : null,
  );
  const { data: session } = authClient.useSession();
  if (!record) return null;
  return resolveMemberAuthor(record, members, session?.user?.id ?? null);
}
