/**
 * Pure data helpers for the post calendar. Kept out of the view component so
 * the date parsing — the part that actually breaks — is unit-testable without
 * a React tree.
 */
import { startOfDay } from "../variant-calendar/date-utils";
import {
  DEFAULT_SCHEDULE_HOUR,
  emptyBlogPayload,
  type PostMeta,
} from "./blog-data";

/** `YYYY-MM-DD` for a `Date`, read in the local timezone. */
export function dayKey(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** A bare calendar date, as written by the editor's `format: "date"` field. */
const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The local calendar day a post's `date` belongs on, or `null` when the value
 * is absent or unparseable (the caller shows those in the undated tray).
 *
 * A bare `YYYY-MM-DD` is a calendar day carrying no timezone, so it is built
 * from its parts: `new Date("2026-08-21")` would parse it as UTC midnight,
 * which lands on Aug 20 for every user west of UTC — the post would sit one
 * cell left of the date its own editor shows. A full ISO timestamp is a real
 * instant instead, so it maps to whichever local day it falls on.
 *
 * A bare date that doesn't survive the round-trip (`2026-02-31` rolls over
 * into March) never existed, so it reads as undated.
 */
export function parsePostDay(date: string): Date | null {
  const trimmed = date.trim();
  if (!trimmed) return null;
  const bare = BARE_DATE.exec(trimmed);
  if (bare) {
    const year = Number(bare[1]);
    const month = Number(bare[2]) - 1;
    const day = Number(bare[3]);
    const parsed = new Date(year, month, day);
    return parsed.getMonth() === month && parsed.getDate() === day
      ? parsed
      : null;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : startOfDay(parsed);
}

/**
 * Payload for a post created straight onto a calendar day: scheduled for
 * {@link DEFAULT_SCHEDULE_HOUR} local time on that day, with the editorial
 * `date` matching so the site shows the day it goes live.
 */
export function scheduledPostPayload(day: Date): Record<string, unknown> {
  const goLive = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    DEFAULT_SCHEDULE_HOUR,
  );
  return {
    ...emptyBlogPayload("posts"),
    status: "scheduled",
    scheduledDatetime: goLive.toISOString(),
    date: dayKey(day),
  };
}

/**
 * The exact instant a value denotes, or null when it isn't one. Unlike
 * {@link parsePostDay} this keeps the time of day, which a move must preserve.
 */
function parseInstant(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (BARE_DATE.test(trimmed)) return parsePostDay(trimmed);
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Move a scheduled post's go-live instant to `day`, keeping its time of day —
 * a post going live at 14:30 dragged three days out still goes live at 14:30.
 *
 * The editorial `date` follows only when it still matches the day the post was
 * scheduled for: once the two have been deliberately pulled apart, a drag must
 * not silently reunite them. Returns null when the post has no usable
 * schedule, so an unscheduled post can't be moved by dragging.
 */
export function rescheduleToDay(
  post: Record<string, unknown>,
  day: Date,
): Record<string, unknown> | null {
  const current = parseInstant(post.scheduledDatetime);
  if (!current) return null;
  const moved = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    current.getHours(),
    current.getMinutes(),
    current.getSeconds(),
    current.getMilliseconds(),
  );
  const next: Record<string, unknown> = {
    ...post,
    scheduledDatetime: moved.toISOString(),
  };
  const editorial = typeof post.date === "string" ? post.date : "";
  if (editorial === dayKey(current)) next.date = dayKey(moved);
  return next;
}

/** One post on the calendar, and why it landed on the day it did. */
export interface CalendarEntry {
  post: PostMeta;
  /**
   * The post carries a `scheduledDatetime`, so its cell is a real go-live
   * instant. When false the post is only placed by its editorial `date` and
   * nothing will publish it — the view marks those apart.
   */
  scheduled: boolean;
}

/**
 * The day a post occupies: its scheduled instant when it has one, otherwise
 * the editorial `date` it displays.
 */
export function entryDay(post: PostMeta): Date | null {
  return parsePostDay(post.scheduledDatetime) ?? parsePostDay(post.date);
}

export interface CalendarPosts {
  /** Local {@link dayKey} → the entries sitting on that day. */
  byDay: Map<string, CalendarEntry[]>;
  /** Posts with no usable date at all, in title order. */
  undated: CalendarEntry[];
}

/**
 * Bucket posts by the local day they fall on. Within a day, scheduled posts
 * come first and ties break on title, so the grid doesn't reshuffle between
 * renders of the same decofile.
 */
export function groupPostsByDay(posts: PostMeta[]): CalendarPosts {
  const byDay = new Map<string, CalendarEntry[]>();
  const undated: CalendarEntry[] = [];
  for (const post of posts) {
    const entry: CalendarEntry = {
      post,
      scheduled: parsePostDay(post.scheduledDatetime) !== null,
    };
    const day = entryDay(post);
    if (!day) {
      undated.push(entry);
      continue;
    }
    const key = dayKey(day);
    const bucket = byDay.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      byDay.set(key, [entry]);
    }
  }
  const order = (a: CalendarEntry, b: CalendarEntry) =>
    Number(b.scheduled) - Number(a.scheduled) ||
    a.post.title.localeCompare(b.post.title);
  for (const bucket of byDay.values()) bucket.sort(order);
  undated.sort(order);
  return { byDay, undated };
}
