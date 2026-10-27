/**
 * A post's own fields: who wrote it, where it is in the pipeline, what its
 * planning card said.
 *
 * `postStatus` and `setPostStatus` are the pair the board is built on — status
 * is a field on the payload, not a place the block lives, so moving a card is
 * one idempotent write instead of a move that can half-happen.
 */
import type { BrandRule } from "./fields";
import { str } from "./fields";
import { listBlogPayloads } from "./decofile-scan";

/** A single category reference, denormalized on a post payload. */
export interface CategoryRef {
  name: string;
  slug: string;
}

/**
 * An author denormalized on a post payload. The post carries the author's
 * FULL record — the blog app renders the author box (type, job title,
 * company, website, avatar) from the post, never from the Author block — so
 * extra fields ride along; `name`/`email` are only the identity.
 */
export interface AuthorRef {
  name: string;
  email: string;
  [field: string]: unknown;
}

/**
 * The site's authors as the refs a post stores — full record, identity
 * stringified. Authors without an email are dropped: nothing could reference
 * them.
 */
export function listAuthorRefs(decofile: Record<string, unknown>): AuthorRef[] {
  return listBlogPayloads(decofile, "authors")
    .map(({ payload }) => ({
      ...payload,
      name: str(payload.name),
      email: str(payload.email),
    }))
    .filter((author) => author.email);
}

/**
 * The lifecycle a post travels, in board order.
 *
 * These values are the blog app's own `PostStatus` union — Studio writes them
 * into `payload.status`, the app reads them, so the vocabulary has to be the
 * app's, not one invented here. Do not add a state the app cannot read.
 *
 * `draft` / `generating` / `awaiting_review` / `archived` are stored as
 * planning-only blocks the site never resolves (see
 * {@link PLANNING_POST_KEY_PREFIX}); `scheduled` / `published` are the live
 * states the site renders.
 */
export type PostStatus =
  | "draft"
  | "generating"
  | "awaiting_review"
  | "scheduled"
  | "published"
  | "archived";

/** The board lanes, left → right — the order the lifecycle advances. */
export const POST_STATUSES: readonly PostStatus[] = [
  "draft",
  "generating",
  "awaiting_review",
  "scheduled",
  "published",
  "archived",
];

/** Local hour of day a newly scheduled post goes live. */
export const DEFAULT_SCHEDULE_HOUR = 8;

/**
 * Publication state from `status` alone. Planning posts always carry an
 * explicit non-live state; on a live post an unset/blank status still means
 * published (legacy: adding the field unpublished nothing).
 *
 * `idea` and `in_review` are read as `draft` / `awaiting_review`: a short-lived
 * Studio-only vocabulary that predates aligning on the blog app's union.
 */
export function postStatus(payload: Record<string, unknown>): PostStatus {
  switch (str(payload.status)) {
    case "draft":
    // Legacy Studio-only name for the first lane.
    case "idea":
      return "draft";
    case "generating":
      return "generating";
    case "awaiting_review":
    // Legacy Studio-only name for the review lane.
    case "in_review":
      return "awaiting_review";
    case "scheduled":
      return "scheduled";
    case "published":
      return "published";
    case "archived":
      return "archived";
    // Legacy: an unset status field means published (adding it unpublishes nothing).
    case "":
      return "published";
    // Any other value is unrecognized — the safest non-live state, not a live post.
    default:
      return "awaiting_review";
  }
}

/** Go-live instant offered when none is set: tomorrow, local, at {@link DEFAULT_SCHEDULE_HOUR}. */
export function defaultScheduledDatetime(now: Date): string {
  const day = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    DEFAULT_SCHEDULE_HOUR,
  );
  return day.toISOString();
}

/** Move a post to `next`: leaving `scheduled` clears the stale instant, entering it seeds one. */
export function setPostStatus(
  payload: Record<string, unknown>,
  next: PostStatus,
  now: Date,
): Record<string, unknown> {
  if (next !== "scheduled") {
    return { ...payload, status: next, scheduledDatetime: "" };
  }
  const existing = str(payload.scheduledDatetime);
  return {
    ...payload,
    status: "scheduled",
    scheduledDatetime: Number.isNaN(new Date(existing).getTime())
      ? defaultScheduledDatetime(now)
      : existing,
  };
}

/**
 * Planning posts (draft / generating / awaiting_review / archived) live one
 * block each under this
 * prefix, carrying NO `__resolveType` — exactly like themes, so the site's blog
 * app never resolves an unfinished draft. Only when a post is scheduled is it
 * promoted to a real `collections/blog/posts/<id>` block the site renders.
 */
export const PLANNING_POST_KEY_PREFIX = "blog-manager/posts/";

/** True when a key points at a planning post — anything but scheduled/published. */
export function isPlanningPostKey(key: string): boolean {
  return key.startsWith(PLANNING_POST_KEY_PREFIX);
}

/** The `<id>` shared by a post's planning and live forms — the last path segment. */
export function postIdOfKey(key: string): string {
  return key.split("/").pop() ?? key;
}

export function planningPostKey(id: string): string {
  return `${PLANNING_POST_KEY_PREFIX}${id}`;
}

export function livePostKey(id: string): string {
  return `collections/blog/posts/${id}`;
}

/**
 * The planning brief a card carries before (and after) generation: the format
 * it should follow and the free-text angle. Stored under `payload.planning`;
 * consumed by generation and shown on the card.
 */
export interface PlanningMeta {
  /** The campaign this post was written for. */
  campaignKey?: string;
  format?: BrandRule;
  brief?: string;
}

/**
 * Every live post as a link target: its title and its slug.
 *
 * Two callers want this list for opposite reasons — an internal-link pass
 * needs somewhere to point, and a new post needs a slug nobody has taken.
 * The editor's `listPostsWithMeta` reads the same payloads for a far richer
 * shape; both go through {@link listBlogPayloads}, so "which blocks are posts"
 * has one answer.
 */
export function postLinkTargets(
  decofile: Record<string, unknown>,
): Array<{ title: string; slug: string }> {
  return listBlogPayloads(decofile, "posts")
    .map(({ payload }) => ({
      title: str(payload.title),
      slug: str(payload.slug),
    }))
    .filter((post) => post.slug);
}
