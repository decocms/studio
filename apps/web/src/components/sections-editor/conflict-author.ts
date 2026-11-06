/**
 * Who made the other change a same-field conflict dialog shows, and when —
 * on hosted v8 drafts only (PO: "only have metadata and changed by on v8
 * hosted"). Fast Preview (v7), Localhost and sandboxes show no line.
 *
 * The hosted CMS stamps, per block, the Studio user id and time of its last
 * change in the draft JSON (`editors`), and a refused save carries the
 * refused block's editor with its value and version, all from the save's
 * own read (`draft[name].editor`). The refusal's editor is kept here per
 * version of theirs ({@link rememberConflictEditor}); nothing else is read.
 * The id is resolved to the member's name and avatar from the org's members
 * (`useMembersQuery`'s cache), `you` for the viewer; only the time when the
 * id isn't a member's. Unknown (a version no refusal carried): no line.
 */

import { spellingKey } from "@decocms/blocks/protocol";
import { canonicalBlockJson } from "@decocms/shared/decofile";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMembersQuery } from "@/hooks/use-members";
import { authClient } from "@/lib/auth-client";
import { KEYS } from "@/lib/query-keys";
import type { ContentBackend } from "./content-backend";
import { versionTag } from "./conflict-editor";
import type { DecofileScopeParams } from "./decofile-api";

export { rememberConflictEditor, versionTag } from "./conflict-editor";

/**
 * The tag of "their version" a conflict dialog about `blockKey` shows, for
 * {@link useConflictAuthor}: the block as the editor holds it now, whole.
 * A refusal records its editor under the tag of the whole block it carried
 * (`rememberConflictEditor`), and puts that block in the cache; a section
 * form's dialog shows only the section's values (an inline section is a part
 * of the page block), so a tag of those would never find the record.
 */
export function heldBlockTag(
  blocks: Record<string, unknown> | null | undefined,
  blockKey: string | null,
): string | null {
  if (!blockKey || !blocks || !Object.hasOwn(blocks, blockKey)) return null;
  return versionTag(canonicalBlockJson(blocks[blockKey] ?? null));
}

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
  // Only what a refusal carried (`rememberConflictEditor`): never fetched.
  const { data } = useQuery<DraftChange | null>({
    queryKey: KEYS.conflictEditor(blockKey ?? "", theirs ?? ""),
    queryFn: () => null,
    enabled: false,
    // Their version changed again: the block's last answer stays shown
    // until a refusal carries the new one.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === (blockKey ?? "") ? previous : undefined,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
  });
  return enabled
    ? { change: data ?? null, pending: false }
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
