/**
 * A card's status carries its post along. The site renders only a live post,
 * so a card scheduled or published moves its post out of planning on the
 * card's branch, and a card moved back returns it. `movePostToStatus` owns the
 * move; this decides what the card's status asks of the post.
 */

import { isPlanningPostKey, str } from "@decocms/shared/blog";
import type { BlogCard, BlogCardStatus } from "@decocms/shared/blog-card";
import {
  blocksPostStatus,
  getBlogPayload,
  livePostKey,
  type MissingFieldKey,
  missingPostFields,
  movePostToStatus,
  planningPostKey,
  type PostMove,
  postIdOfKey,
  type PostStatus,
  postStatus,
} from "@/components/sandbox/content/blog/blog-data";

/** The status a card's post takes for each status a person moves the card to. */
const POST_STATUS_FOR = {
  ideas: "draft",
  awaiting_review: "awaiting_review",
  scheduled: "scheduled",
  published: "published",
} as const satisfies Record<Exclude<BlogCardStatus, "generating">, PostStatus>;

const isBlock = (value: unknown) => !!value && typeof value === "object";

/**
 * The post's block on the card's branch: the key the card holds, or wherever
 * its id sits now, since the Site Editor moves a post without telling the card.
 */
export function cardPostKey(
  card: Pick<BlogCard, "id" | "postKey">,
  decofile: Record<string, unknown>,
): string | null {
  const id = card.postKey ? postIdOfKey(card.postKey) : card.id;
  const keys = [card.postKey, planningPostKey(id), livePostKey(id)];
  return keys.find((key) => key && isBlock(decofile[key])) ?? null;
}

export type CardPostMove =
  /** The post moves: write and delete per `plan`, then point the card at `to`. */
  | { kind: "move"; from: string; to: string; plan: PostMove }
  /** The post already has that status; only the card changes. */
  | { kind: "same"; key: string }
  /** No block of the card's post on its branch. */
  | { kind: "missing" }
  /** It cannot go live without these. */
  | { kind: "incomplete"; fields: MissingFieldKey[] };

/** A go-live instant the post lacks, taken from the one the card's agent suggested. */
function withSuggestedInstant(
  payload: Record<string, unknown>,
  suggested: string | undefined,
): Record<string, unknown> {
  const valid = (value: string) => !Number.isNaN(new Date(value).getTime());
  const stored = str(payload.scheduledDatetime);
  if (valid(stored) || !suggested || !valid(suggested)) return payload;
  return {
    ...payload,
    scheduledDatetime: new Date(suggested).toISOString(),
  };
}

/** What moving the card to `status` asks of its post on `decofile`, the card's branch. */
export function cardPostMove(
  card: Pick<BlogCard, "id" | "postKey"> & {
    hypothesis?: { publishAt?: string };
  },
  decofile: Record<string, unknown>,
  status: Exclude<BlogCardStatus, "generating">,
  now: Date,
): CardPostMove {
  const key = cardPostKey(card, decofile);
  if (!key) return { kind: "missing" };
  const next = POST_STATUS_FOR[status];
  const stored = getBlogPayload(
    decofile[key] as Record<string, unknown>,
    "posts",
  );
  // A planning block marked `scheduled` by hand is still off the site.
  const live = next === "scheduled" || next === "published";
  if (postStatus(stored) === next && live !== isPlanningPostKey(key)) {
    return { kind: "same", key };
  }
  const payload =
    next === "scheduled"
      ? withSuggestedInstant(stored, card.hypothesis?.publishAt)
      : stored;
  if (blocksPostStatus(payload, next)) {
    return { kind: "incomplete", fields: missingPostFields(payload) };
  }
  const plan = movePostToStatus({ key, payload }, next, now);
  return {
    kind: "move",
    from: key,
    to: Object.keys(plan.writes)[0] ?? key,
    plan,
  };
}
