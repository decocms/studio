import type { BoardColumn } from "@decocms/shared/task-board";
import { CANONICAL_COLUMN_KEYS } from "@decocms/shared/task-board";
import type {
  ColumnAutomation,
  ColumnAutomationStorage,
} from "@/storage/task-board-column-automations";
import type { BoardColumnStorage } from "@/storage/task-board-columns";
import type { StudioContext } from "@/core/studio-context";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";

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
   * What runs when a card lands in `columnKey`, or null when this board does
   * nothing there — which is the normal answer for most columns.
   */
  automationFor(columnKey: string): Promise<ColumnAutomation | null>;

  /**
   * Where the sweep retires a finished card, or null when this board has
   * nowhere to retire one to.
   *
   * Nullable for the same reason `automationFor` is: a board whose columns are
   * the org's own may simply not have a column that means "archived", and
   * writing our own key into a card on that board would file it under a column
   * that does not exist — invisible, which is worse than not archiving.
   */
  archiveColumn(): Promise<string | null>;

  /**
   * What to write into a card's `board_column_org` — the org id when this
   * board's columns are rows the foreign key can hold it to, null when they
   * are Studio's constants and the key must stay asleep.
   *
   * Asked of the board rather than recomputed from the flag at each writer, so
   * one answer cannot drift from another and leave a card unguarded.
   */
  columnOwner(): string | null;
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

/** The board Studio ships with: a fixed set of columns, and whatever rules the
 *  org has hung on them. */
class StudioBoardHandler implements BoardHandler {
  constructor(
    private readonly organizationId: string,
    private readonly automations: ColumnAutomationStorage,
  ) {}

  columns(): Promise<BoardColumn[]> {
    return Promise.resolve(CANONICAL);
  }

  automationFor(columnKey: string): Promise<ColumnAutomation | null> {
    return this.automations.get(this.organizationId, columnKey);
  }

  archiveColumn(): Promise<string | null> {
    return Promise.resolve("archived");
  }

  columnOwner(): string | null {
    return null;
  }
}

/**
 * A board whose columns belong to the org, not to Studio.
 *
 * Named for who defines the set, not for where it came from. Today the only
 * source is a Jira board, but mirroring is something the SYNC does; this side
 * only knows the columns are not ours to invent. A column someone typed by
 * hand would land here too and nothing would need renaming.
 *
 * Only `columns` differs from Studio's own board: the rules hang off a column
 * key either way, so whose board it is has no bearing on what runs where. That
 * is the point of keying automations by column rather than by lane.
 */
class OrgBoardHandler implements BoardHandler {
  constructor(
    private readonly organizationId: string,
    private readonly automations: ColumnAutomationStorage,
    private readonly boardColumns: BoardColumnStorage,
  ) {}

  columns(): Promise<BoardColumn[]> {
    return this.boardColumns.listByOrg(this.organizationId);
  }

  automationFor(columnKey: string): Promise<ColumnAutomation | null> {
    return this.automations.get(this.organizationId, columnKey);
  }

  /** Whichever column the org marked as its archive, and none by default: a
   *  column mirrored from a tracker means nothing to us until someone says it
   *  does. */
  async archiveColumn(): Promise<string | null> {
    const columns = await this.boardColumns.listByOrg(this.organizationId);
    return columns.find((column) => column.role === "archived")?.key ?? null;
  }

  columnOwner(): string | null {
    return this.organizationId;
  }
}

export interface BoardHandlerDeps {
  automations: ColumnAutomationStorage;
  boardColumns: BoardColumnStorage;
  /** `org_board_columns` — see `OrgFlagsSchema`. */
  orgOwnedColumns: boolean;
}

/**
 * This org's board.
 *
 * The one place the two answers are chosen between, which is why every caller
 * asks the board rather than reading a status. An org board with no columns yet
 * is still an org board: it renders empty rather than falling back to Studio's
 * lanes, because falling back would silently re-introduce a vocabulary the org
 * has said it does not use.
 */
export function boardHandler(
  organizationId: string,
  deps: BoardHandlerDeps,
): BoardHandler {
  return deps.orgOwnedColumns
    ? new OrgBoardHandler(organizationId, deps.automations, deps.boardColumns)
    : new StudioBoardHandler(organizationId, deps.automations);
}

/**
 * This org's board, with its mode read for you.
 *
 * The single construction point: every caller goes through here, so which
 * board an org has is decided once instead of at each site.
 */
export async function boardFor(
  ctx: StudioContext,
  organizationId: string,
): Promise<BoardHandler> {
  const settings = await ctx.storage.organizationSettings.get(organizationId);
  return boardHandler(organizationId, {
    automations: ctx.storage.columnAutomations,
    boardColumns: ctx.storage.boardColumns,
    orgOwnedColumns: orgFlagEnabled(settings?.flags, "org_board_columns"),
  });
}

/**
 * The patch every route that ships or archives a card writes: the target
 * status alongside the board's own discriminator. One helper so a new ship
 * path can't repeat `{ status, boardColumnOrg }` and forget the guard — the
 * exact gap that let a card land unguarded on an org-owned board (#6725,
 * #6739) in the sweep paths that already remembered it.
 */
export function shippedPatch(
  board: BoardHandler,
  status: string,
): { status: string; boardColumnOrg: string | null } {
  return { status, boardColumnOrg: board.columnOwner() };
}

/**
 * Refuse a status this board has no column for.
 *
 * What the closed enum used to do, moved to where the answer actually lives:
 * only the board knows which keys are real for this org. Silence here means a
 * card filed under a column that does not exist — it renders nowhere, which is
 * the worst way for a bug to arrive.
 */
export async function assertBoardHasColumn(
  board: BoardHandler,
  status: string,
): Promise<void> {
  const columns = await board.columns();
  if (columns.some((column) => column.key === status)) return;
  throw new Error(
    `This board has no column "${status}" — it has ${
      columns.map((c) => c.key).join(", ") || "none yet"
    }`,
  );
}
