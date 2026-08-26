/**
 * The members the mention picker offers, kept warm across reloads.
 *
 * The list opens on a keystroke, so waiting on a round-trip would mean an empty
 * menu under the caret every time. The last list is kept in `localStorage` and
 * shown immediately; the fetch still runs, in the background, and merges into
 * what's on screen.
 *
 * Merging, rather than replacing: a member whose fields didn't change keeps its
 * object identity, so React re-renders only the rows that are actually new. A
 * replacement would re-render the whole list — a visible flash under a menu the
 * user is already reading.
 */

import { useQuery } from "@tanstack/react-query";
import { useOrgAuthClient } from "@/hooks/use-org-auth-client";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";

export interface MentionMember {
  /** The user id — what a mention stores and what notifies. */
  id: string;
  name: string;
  email: string;
  image: string | null;
}

const STORAGE_PREFIX = "studio.mention-members.";

/** Parsed copies, so the picker doesn't re-parse the cache on every render. */
const parsed = new Map<string, MentionMember[]>();

function readCache(key: string): MentionMember[] | undefined {
  const hit = parsed.get(key);
  if (hit) return hit;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return undefined;
    // Trust nothing from storage: it survives deploys that changed this shape.
    const members = value.filter(
      (m): m is MentionMember =>
        !!m && typeof m.id === "string" && typeof m.name === "string",
    );
    parsed.set(key, members);
    return members;
  } catch {
    // Private mode, quota, corrupt JSON — a cold list is the fallback.
    return undefined;
  }
}

function writeCache(key: string, members: MentionMember[]): void {
  parsed.set(key, members);
  try {
    localStorage.setItem(key, JSON.stringify(members));
  } catch {
    // Storage being unavailable costs a cold open, nothing more.
  }
}

/**
 * `next` with each unchanged member replaced by its `previous` object, so only
 * genuinely new or edited rows change identity.
 */
export function mergeMembers(
  previous: MentionMember[] | undefined,
  next: MentionMember[],
): MentionMember[] {
  if (!previous?.length) return next;
  const byId = new Map(previous.map((m) => [m.id, m]));
  return next.map((member) => {
    const old = byId.get(member.id);
    return old &&
      old.name === member.name &&
      old.email === member.email &&
      old.image === member.image
      ? old
      : member;
  });
}

interface RawMember {
  userId: string;
  user?: { name?: string; email?: string; image?: string | null };
}

function toMentionMembers(rows: RawMember[]): MentionMember[] {
  return rows
    .map((row) => ({
      id: row.userId,
      // An invited member who never set a name still has to be pickable.
      name: row.user?.name?.trim() || row.user?.email?.trim() || "",
      email: row.user?.email ?? "",
      image: row.user?.image ?? null,
    }))
    .filter((m) => !!m.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function useMentionMembers(enabled: boolean) {
  const { locator } = useProjectContext();
  const orgAuth = useOrgAuthClient();
  const storageKey = `${STORAGE_PREFIX}${locator}`;

  const query = useQuery({
    queryKey: KEYS.mentionMembers(locator),
    enabled,
    // No stale window: the picker opening IS the signal to re-check. The
    // cached list is on screen throughout, so the refetch costs nothing seen.
    staleTime: 0,
    placeholderData: () => readCache(storageKey),
    queryFn: async () => {
      const res = await orgAuth.organization.listMembers();
      const members = mergeMembers(
        readCache(storageKey),
        toMentionMembers((res?.data?.members ?? []) as RawMember[]),
      );
      writeCache(storageKey, members);
      return members;
    },
  });

  return {
    members: query.data ?? [],
    /** Only true with nothing to show — a refresh over a cached list is
     *  silent by design. */
    loading: query.isFetching && !query.data,
  };
}
