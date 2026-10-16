/**
 * Who made the other change, and when: what the site editor's "someone else
 * changed this" dialog shows next to their version.
 *
 * Nothing new is stored for a git-backed draft. Every Fast Preview save is a
 * commit on the draft branch carrying the Studio user as a `Co-authored-by:`
 * trailer (`appendCoAuthorTrailer`), so the block file's latest commit says
 * who and when: the trailer, else the commit's author when it is a person
 * (a developer's push), and the commit time. A Blocks v8 draft is an object
 * on the delivery bucket instead: the editor reads who changed the names it
 * holds from the draft's own edits (`DraftEdit`), and asks here only for the
 * others, which are main's, like a v7 block.
 *
 * The identity is shown as the org's member (name, avatar) when
 * it is one, else by its git name; `you` when it is the viewer (another tab
 * or window). Unknown parts are left out, never guessed.
 */

import type { Database } from "@/storage/types";
import type { Kysely } from "kysely";
import {
  loginLooksLikeBot,
  type RepoCommit,
  type RepoInsightsClient,
} from "@/git-providers/insights";

/** The wire shape, per block key, of `GET …/changed-by`. */
export interface ChangedBy {
  /** The member's name, else the git name; absent when only the time is known. */
  name?: string;
  /** The member's email (never a raw git address). */
  email?: string;
  avatarUrl?: string;
  /** ISO time of the change. */
  at: string;
  /** The viewer made it (in another tab or window). */
  you?: true;
}

/** Who changed a block, as its history says, before mapping to members. */
export interface ChangeAuthor {
  name: string | null;
  email: string | null;
  /** A Studio user id, when the history recorded one. */
  userId: string | null;
  at: string;
}

export interface OrgMember {
  userId: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

/** The org's members among these emails (any case) or user ids. */
export type MemberLookup = (query: {
  emails: string[];
  userIds: string[];
}) => Promise<OrgMember[]>;

const CO_AUTHOR_RE = /^Co-authored-by:\s*(.+?)\s*(?:<([^<>\s]+)>)?\s*$/i;

/** The last `Co-authored-by:` trailer of a commit message, or null. */
export function coAuthorOf(
  message: string,
): { name: string; email: string | null } | null {
  let found: { name: string; email: string | null } | null = null;
  for (const line of message.split("\n")) {
    const match = CO_AUTHOR_RE.exec(line.trim());
    if (match?.[1]) found = { name: match[1], email: match[2] ?? null };
  }
  return found;
}

function validTime(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Who a commit says changed the file: its co-author trailer (the Studio
 * user), else its author unless that is a machine. Null without a valid time.
 */
export function authorOfCommit(commit: RepoCommit): ChangeAuthor | null {
  const at = validTime(commit.date);
  if (!at) return null;
  const trailer = coAuthorOf(`${commit.message}\n${commit.body ?? ""}`);
  if (trailer) {
    return { name: trailer.name, email: trailer.email, userId: null, at };
  }
  const { name, email, login } = commit.author;
  const bot =
    (login !== null && loginLooksLikeBot(login)) ||
    (name !== null && loginLooksLikeBot(name));
  if (bot) return { name: null, email: null, userId: null, at };
  return { name: name?.trim() || null, email, userId: null, at };
}

/** How far back a block's latest change is looked for. */
const HISTORY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The latest commit on `ref` that changed `path`: one provider call (a
 * history filtered by path, one row). Null when there is none in the window.
 */
export async function latestChangeOf(
  insights: Pick<RepoInsightsClient, "listCommits">,
  ref: string,
  path: string,
  now = Date.now(),
): Promise<ChangeAuthor | null> {
  const page = await insights.listCommits({
    ref,
    path,
    since: new Date(now - HISTORY_WINDOW_MS).toISOString(),
    limit: 1,
  });
  const commit = page.items[0];
  return commit ? authorOfCommit(commit) : null;
}

/**
 * Authors → what the dialog shows: the org member's name and avatar when the
 * author is one (by user id, else email), else the git name; `you` when it is
 * the viewer. One member query for all of them.
 */
export async function toChangedBy(
  authors: Record<string, ChangeAuthor>,
  lookup: MemberLookup,
  viewer: { id: string | null; email?: string | null },
): Promise<Record<string, ChangedBy>> {
  const list = Object.values(authors);
  const emails = [
    ...new Set(list.flatMap((a) => (a.email ? [a.email.toLowerCase()] : []))),
  ];
  const userIds = [
    ...new Set(list.flatMap((a) => (a.userId ? [a.userId] : []))),
  ];
  const members =
    emails.length + userIds.length > 0
      ? await lookup({ emails, userIds }).catch(() => [])
      : [];
  const byId = new Map(members.map((m) => [m.userId, m]));
  const byEmail = new Map(
    members.flatMap((m) => (m.email ? [[m.email.toLowerCase(), m]] : [])),
  );
  const viewerEmail = viewer.email?.toLowerCase() ?? null;
  const out: Array<[string, ChangedBy]> = [];
  for (const [key, author] of Object.entries(authors)) {
    const member =
      (author.userId ? byId.get(author.userId) : undefined) ??
      (author.email ? byEmail.get(author.email.toLowerCase()) : undefined);
    const name = member?.name?.trim() || author.name?.trim() || undefined;
    const you =
      (!!viewer.id &&
        (member?.userId === viewer.id || author.userId === viewer.id)) ||
      (!!viewerEmail && author.email?.toLowerCase() === viewerEmail);
    out.push([
      key,
      {
        ...(name ? { name } : {}),
        ...(member?.email ? { email: member.email } : {}),
        ...(member?.image ? { avatarUrl: member.image } : {}),
        at: author.at,
        ...(you ? { you: true as const } : {}),
      },
    ]);
  }
  // fromEntries: a block named "__proto__" stays an entry.
  return Object.fromEntries(out);
}

/** {@link MemberLookup} over the org's `member` rows. */
export function memberLookupFor(
  db: Kysely<Database>,
  organizationId: string,
): MemberLookup {
  return async ({ emails, userIds }) => {
    if (emails.length + userIds.length === 0) return [];
    const rows = await db
      .selectFrom("member")
      .innerJoin("user", "user.id", "member.userId")
      .select([
        "member.userId as userId",
        "user.name as name",
        "user.email as email",
        "user.image as image",
      ])
      .where("member.organizationId", "=", organizationId)
      .where((eb) =>
        eb.or([
          ...(userIds.length > 0 ? [eb("member.userId", "in", userIds)] : []),
          ...(emails.length > 0
            ? [eb(eb.fn("lower", ["user.email"]), "in", emails)]
            : []),
        ]),
      )
      .execute();
    return rows.map((row) => ({
      userId: row.userId,
      name: row.name ?? null,
      email: row.email ?? null,
      image: row.image ?? null,
    }));
  };
}

/** At most this many blocks per `changed-by` request: one provider call each. */
export const MAX_CHANGED_BY_BLOCKS = 5;

/**
 * Each block's latest change on `ref`, by its file path: one history call
 * per block, in parallel. A block whose history can't be read is left out.
 */
export async function gitChangeAuthors(
  insights: Pick<RepoInsightsClient, "listCommits">,
  ref: string,
  paths: Record<string, string>,
): Promise<Record<string, ChangeAuthor>> {
  const found = await Promise.all(
    Object.entries(paths).map(async ([key, path]) => {
      try {
        const author = await latestChangeOf(insights, ref, path);
        return author ? ([[key, author]] as const) : [];
      } catch (error) {
        console.warn("changed-by: history unreadable", {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    }),
  );
  return Object.fromEntries(found.flat());
}
