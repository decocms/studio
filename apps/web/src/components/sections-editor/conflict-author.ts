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
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { mainSchemaHeaders } from "@/hooks/main-schema-changed";
import { useMembersQuery } from "@/hooks/use-members";
import { authClient } from "@/lib/auth-client";
import { KEYS } from "@/lib/query-keys";
import type { ContentBackend } from "./content-backend";
import type { DecofileScopeParams } from "./decofile-api";

/** What the dialog shows: a member's name and avatar, or only the time. */
export interface ConflictAuthor {
  name?: string;
  /**
   * How a title names them: their first name, or their whole name when
   * another member shares that first name ("Demo" and "Demo 2").
   */
  shortName?: string;
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
      {
        cache: "no-store",
        headers: mainSchemaHeaders("v8"),
        // The A/B test and campaign windows wait for this read before they
        // open (a section form's opens at once): never for long.
        signal: AbortSignal.timeout(AUTHOR_READ_TIMEOUT_MS),
      },
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

/** How long a dialog waits to name who made the other change. */
const AUTHOR_READ_TIMEOUT_MS = 2500;

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

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
  const first = name ? firstName(name) : undefined;
  const shared =
    !!first &&
    members.some(
      (m) =>
        m.userId !== change.userId &&
        firstName(m.user?.name?.trim() ?? "").toLocaleLowerCase() ===
          first.toLocaleLowerCase(),
    );
  return {
    ...(name ? { name, shortName: shared ? name : first } : {}),
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
 * changes ("Their version changed again") the record is read again, the
 * last answer for the block shown meanwhile. Undefined while the first
 * answer is read (the dialog opens all the same, its titles naming no one
 * rather than switching from "Someone else" to a name); null when unknown.
 */
export function useConflictAuthor(
  draft: DecofileScopeParams | null,
  blockKey: string | null,
  theirs: string | null,
): ConflictAuthor | null | undefined {
  const { change, pending } = useDraftChange(draft, blockKey, theirs);
  const membersQuery = useMembersQuery({ enabled: !!change });
  const members =
    (membersQuery.data as { data?: { members?: OrgMemberRow[] } } | undefined)
      ?.data?.members ?? [];
  const { data: session } = authClient.useSession();
  if (pending) return undefined;
  if (!change) return null;
  // The members' first read: a failed one shows only the time.
  if (membersQuery.isLoading && membersQuery.failureCount === 0) {
    return undefined;
  }
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
): ConflictAuthor | null | undefined {
  const { change, pending } = useDraftChange(draft, blockKey, theirs);
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  // A members list still on its first read (rendered again once it lands).
  const membersReading = useIsFetching({ predicate: isMembersQuery }) > 0;
  if (pending) return undefined;
  if (!change) return null;
  const members = queryClient
    .getQueriesData<{ data?: { members?: OrgMemberRow[] } }>({
      predicate: isMembersQuery,
    })
    .flatMap(([, data]) => data?.data?.members ?? []);
  if (members.length === 0 && membersReading) return undefined;
  return resolveDraftChange(change, members, session?.user?.id ?? null);
}

const isMembersQuery = (query: { queryKey: readonly unknown[] }) =>
  query.queryKey[1] === "members";

function useDraftChange(
  draft: DecofileScopeParams | null,
  blockKey: string | null,
  theirs: string | null,
): { change: DraftChange | null; pending: boolean } {
  const enabled = !!draft && !!blockKey && theirs !== null;
  const { data, isPending } = useQuery({
    queryKey: KEYS.conflictAuthor(
      draft ? `${draft.orgSlug}/${draft.virtualMcpId}/${draft.branch}` : "",
      blockKey ?? "",
      theirs ?? "",
    ),
    queryFn: () => readDraftChange(draft!, blockKey!),
    enabled,
    // Their version changed again: the block's last answer stays shown
    // while the new one is read (never "Someone else" in between).
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === (blockKey ?? "") ? previous : undefined,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return enabled
    ? { change: data ?? null, pending: isPending }
    : { change: null, pending: false };
}

/**
 * Reads the org's members on a screen whose hosted v8 saves may be asked
 * about (`hosted`), so the reconcile window, shown outside the project's
 * screens ({@link useConflictAuthorFromCache}), names who made the other
 * change rather than "Someone else". Nothing is read elsewhere.
 */
export function useConflictMembers(hosted: boolean): void {
  useMembersQuery({ enabled: hosted });
}
