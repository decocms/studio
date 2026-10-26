/**
 * Who made the other change a same-field conflict dialog shows, and when —
 * on hosted v8 drafts only (PO: "only have metadata and changed by on v8
 * hosted"). Fast Preview (v7), Localhost and sandboxes show no line.
 *
 * The draft object's storage metadata records, per block, the Studio user id
 * and time of its last change; the session read answers it as `changedBy`
 * next to the draft pointer. The id is resolved to the member's name and
 * avatar from the org's members (`useMembersQuery`'s cache), `you` for the
 * viewer; only the time when the id isn't a member's.
 *
 * Read once per version of theirs the dialog shows (the query key carries
 * it), never per poll; a failure is "unknown", and the dialog then shows no
 * line at all.
 */

import { spellingKey } from "@decocms/blocks/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { mainSchemaHeaders } from "@/hooks/main-schema-changed";
import { useMembersQuery } from "@/hooks/use-members";
import { authClient } from "@/lib/auth-client";
import { KEYS } from "@/lib/query-keys";
import type { ContentBackend } from "./content-backend";
import type { DecofileScopeParams } from "./decofile-api";

/** What the dialog shows: a member's name and avatar, or only the time. */
export interface ConflictAuthor {
  name?: string;
  avatarUrl?: string;
  at: string;
  /** The viewer made it (in another tab or window). */
  you: boolean;
}

/** One block's last change, as the session read answers it. */
export interface DraftChange {
  userId: string;
  at: string;
}

/** The hosted v8 draft whose metadata can say who changed a block, or null. */
export function conflictAuthorDraft(
  backend: ContentBackend,
  params: DecofileScopeParams,
): DecofileScopeParams | null {
  return backend.kind === "protocol" && backend.source === "github"
    ? params
    : null;
}

/** `blockKey`'s change in the draft's `changedBy`, by any spelling of its name. */
export function draftChangeFor(
  changedBy: Record<string, DraftChange>,
  blockKey: string,
): DraftChange | null {
  if (Object.hasOwn(changedBy, blockKey)) return changedBy[blockKey] ?? null;
  const key = spellingKey(blockKey);
  const name = Object.keys(changedBy).find((n) => spellingKey(n) === key);
  return name === undefined ? null : (changedBy[name] ?? null);
}

/** The session read's `changedBy` (the draft object's metadata). */
async function readDraftChange(
  params: DecofileScopeParams,
  blockKey: string,
): Promise<DraftChange | null> {
  try {
    const res = await fetch(
      `/api/${params.orgSlug}/decofile/${encodeURIComponent(params.virtualMcpId)}/${encodeURIComponent(params.branch)}`,
      { cache: "no-store", headers: mainSchemaHeaders("v8") },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as {
      changedBy?: Record<string, DraftChange>;
    };
    const change = draftChangeFor(body.changedBy ?? {}, blockKey);
    return change &&
      typeof change.userId === "string" &&
      Number.isFinite(Date.parse(change.at))
      ? change
      : null;
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
 * A draft change as the dialog shows it: the member's name and avatar, `you`
 * for the viewer; only the time when the id isn't a member's.
 */
export function resolveDraftChange(
  change: DraftChange,
  members: readonly OrgMemberRow[],
  viewerId: string | null,
): ConflictAuthor {
  const member = members.find((m) => m.userId === change.userId);
  const name = member?.user?.name?.trim();
  const avatarUrl = member?.user?.image ?? undefined;
  return {
    ...(name ? { name } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    at: change.at,
    you: !!viewerId && change.userId === viewerId,
  };
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
 * Who made the change a conflict dialog shows, on a hosted v8 draft (`draft`
 * null: nothing to show). `theirs` identifies the version shown: when it
 * changes ("Their version changed again") the record is read again. Null
 * while unknown.
 */
export function useConflictAuthor(
  draft: DecofileScopeParams | null,
  blockKey: string | null,
  theirs: string | null,
): ConflictAuthor | null {
  const change = useDraftChange(draft, blockKey, theirs);
  const { data: membersData } = useMembersQuery({ enabled: !!change });
  const members =
    (membersData as { data?: { members?: OrgMemberRow[] } } | undefined)?.data
      ?.members ?? [];
  const { data: session } = authClient.useSession();
  if (!change) return null;
  return resolveDraftChange(change, members, session?.user?.id ?? null);
}

/**
 * {@link useConflictAuthor} for a dialog shown outside a project's screens
 * (the reconcile host, mounted with the app's providers): the member is
 * found in the org's member lists already read (none read: only the time).
 */
export function useConflictAuthorFromCache(
  draft: DecofileScopeParams | null,
  blockKey: string | null,
  theirs: string | null,
): ConflictAuthor | null {
  const change = useDraftChange(draft, blockKey, theirs);
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  if (!change) return null;
  const members = queryClient
    .getQueriesData<{ data?: { members?: OrgMemberRow[] } }>({
      predicate: (query) => query.queryKey[1] === "members",
    })
    .flatMap(([, data]) => data?.data?.members ?? []);
  return resolveDraftChange(change, members, session?.user?.id ?? null);
}

function useDraftChange(
  draft: DecofileScopeParams | null,
  blockKey: string | null,
  theirs: string | null,
): DraftChange | null {
  const enabled = !!draft && !!blockKey && theirs !== null;
  const { data } = useQuery({
    queryKey: KEYS.conflictAuthor(
      draft ? `${draft.orgSlug}/${draft.virtualMcpId}/${draft.branch}` : "",
      blockKey ?? "",
      theirs ?? "",
    ),
    queryFn: () => readDraftChange(draft!, blockKey!),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return enabled ? (data ?? null) : null;
}
