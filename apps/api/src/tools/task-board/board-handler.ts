import type { BoardColumn } from "@decocms/shared/task-board";
import { CANONICAL_COLUMN_KEYS } from "@decocms/shared/task-board";

/**
 * A board's behaviour, as the questions its callers actually have.
 *
 * Deliberately not a lookup like "give me the column for role R". That would
 * leave `"todo"` and `"in_review"` written at every call site, which is the
 * thing being removed — the caller would still be reasoning in Studio's
 * vocabulary, just through one more hop.
 *
 * So each method is a decision. Studio's own board decides with an `if` over
 * the lanes it ships. A board mirrored from a customer's tracker decides by
 * reading what someone configured for that column, and answers null wherever
 * nothing is — which is most columns, and must stay uneventful rather than
 * fall back to a guess.
 */
export interface BoardHandler {
  /** The columns to render, left to right. */
  columns(): Promise<BoardColumn[]>;

  /**
   * Does a card landing in `columnKey` start work?
   *
   * Boolean while every board that exists runs the Super Agent's built-in
   * prompt. The prompt becomes part of this answer with the implementation
   * that can actually carry one, rather than being modelled now and returned
   * null by everybody.
   */
  startsWorkOn(columnKey: string): Promise<boolean>;
}

/** `title` is the key: the canonical columns are translated by the client,
 *  which is the only place that knows the reader's language. A mirrored column
 *  carries the name its tracker gave it, which is not ours to translate. */
const CANONICAL: BoardColumn[] = CANONICAL_COLUMN_KEYS.map((key, position) => ({
  key,
  title: key,
  position,
  role: key,
}));

/** The board Studio ships with: a fixed set, and one lane that starts work. */
class StaticBoardHandler implements BoardHandler {
  columns(): Promise<BoardColumn[]> {
    return Promise.resolve(CANONICAL);
  }

  startsWorkOn(columnKey: string): Promise<boolean> {
    return Promise.resolve(columnKey === "todo");
  }
}

const STATIC = new StaticBoardHandler();

/**
 * This org's board.
 *
 * One implementation today. It takes the org so every call site is already
 * written the way it needs to be once a board can be tracker-owned instead,
 * and choosing between the two is a change here rather than at each caller.
 */
export function boardHandler(_organizationId: string): BoardHandler {
  return STATIC;
}
