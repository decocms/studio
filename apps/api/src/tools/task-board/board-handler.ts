import type { BoardColumn } from "@decocms/shared/task-board";
import { CANONICAL_COLUMN_KEYS } from "@decocms/shared/task-board";
import type { Kysely } from "kysely";
import {
  type ColumnAutomation,
  ColumnAutomationStorage,
} from "@/storage/task-board-column-automations";
import { BoardColumnStorage } from "@/storage/task-board-columns";
import { OrganizationSettingsStorage } from "@/storage/organization-settings";
import type { Database } from "@/storage/types";
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
/**
 * The columns a board gives Studio's lifecycle meanings.
 *
 * Every field but `intake` is nullable, and null means the same thing
 * throughout: this board has no column that means this. The honest response is
 * then to do nothing — not to write one of Studio's keys, which on a mirrored
 * board files the card under a column that does not exist and makes it vanish.
 *
 * `intake` cannot be null because a card has to be created somewhere, and
 * refusing to create it is worse than any column.
 */
export interface BoardLanes {
  /** Where a card is born. */
  intake: string;
  /** Queued for the agent to pick up — the claim's starting line. */
  queue: string | null;
  /** Being worked on. */
  progress: string | null;
  /** Waiting on review. */
  review: string | null;
  /** Retired. */
  archive: string | null;
}

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
   * Every column Studio's own lifecycle needs a name for, resolved together.
   *
   * Together rather than one method each, for two reasons. It is one read
   * instead of five. And the storage layer needs these as VALUES — its fences
   * and sweeps are SQL predicates, so "which column means in-progress" has to
   * be answered before the query is built, not asked from inside it.
   */
  lanes(): Promise<BoardLanes>;

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

/**
 * Studio's own board, as lanes.
 *
 * These are exactly the string literals that used to be hardcoded at every
 * writer and every SQL predicate. Keeping them identical is what makes this
 * seam a no-op for every org on the canonical board — which is every org but
 * the ones that opted into mirroring.
 */
const STUDIO_LANES: BoardLanes = {
  intake: "triage",
  queue: "todo",
  progress: "in_progress",
  review: "in_review",
  archive: "archived",
};

/** `title` is the key: the canonical columns are translated by the client,
 *  which is the only place that knows the reader's language. A mirrored column
 *  carries the name its tracker gave it, which is not ours to translate. */
const CANONICAL: BoardColumn[] = CANONICAL_COLUMN_KEYS.map((key, position) => ({
  key,
  title: key,
  position,
  role: key,
  // Studio's board mirrors nothing, so it groups no tracker statuses. An org
  // on this board that also syncs Jira still pushes through its hand-written
  // status mapping; see `jiraTargetsForLane`.
  trackerStatuses: [],
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
    return Promise.resolve(STUDIO_LANES.archive);
  }

  lanes(): Promise<BoardLanes> {
    return Promise.resolve(STUDIO_LANES);
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
    return (await this.lanes()).archive;
  }

  /**
   * Whichever columns the org gave these meanings to, and none by default: a
   * column mirrored from a tracker means nothing to us until someone says it
   * does.
   *
   * `intake` is the leftmost column rather than a role. Intake is the one
   * decision with no acceptable null, and making it a role would turn "create
   * a card" into a setup step; the left edge of a board is where new work
   * appears in every tracker that has one.
   */
  async lanes(): Promise<BoardLanes> {
    const columns = await this.boardColumns.listByOrg(this.organizationId);
    const withRole = (role: string) =>
      columns.find((column) => column.role === role)?.key ?? null;
    const first = columns[0];
    if (!first) {
      throw new Error(
        "This board has no columns yet — nothing has been mirrored from the tracker",
      );
    }
    return {
      intake: first.key,
      queue: withRole("todo"),
      progress: withRole("in_progress"),
      review: withRole("in_review"),
      archive: withRole("archived"),
    };
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
 * Whether a card sitting in `from` may still be advanced to `to`.
 *
 * True when `from` is at or before `to` in the board's OWN order, which is
 * what stops a re-opened PR dragging a finished card backwards.
 *
 * Position rather than a fixed list of lane names, because a mirrored board's
 * columns are ordered and named by its tracker — "has it got past this yet" is
 * a question only the board can answer. On Studio's board the answer is the
 * same set the hardcoded list held. A column this board does not have is not
 * advanceable at all: a card nobody can place is not one to move.
 */
export function canAdvance(
  columns: readonly BoardColumn[],
  from: string,
  to: string,
): boolean {
  const at = (key: string) => columns.find((c) => c.key === key)?.position;
  const fromAt = at(from);
  const toAt = at(to);
  return fromAt !== undefined && toAt !== undefined && fromAt <= toAt;
}

/** One warning per org and meaning. A board nobody configured would otherwise
 *  log on every sweep tick, which is the fastest way to make the signal
 *  worthless. Capped rather than TTL'd: the key set is bounded by orgs times
 *  meanings, and a full reset just re-warns once. */
const warnedLanes = new Set<string>();
const WARNED_LANES_CAP = 10_000;

/**
 * Whether this board can express `meaning`, warning once when it cannot.
 *
 * A fence that declines for want of a column looks exactly like a fence that
 * lost a race — both just return null — so an unconfigured board does nothing
 * and says nothing. This is the line that tells the difference, and it narrows
 * `lane` to a string for the caller that proceeds.
 */
export function boardCan(
  organizationId: string,
  meaning: string,
  lane: string | null,
  /** What will not happen, in words a person can act on. */
  what: string,
): lane is string {
  if (lane !== null) return true;
  const key = `${organizationId}:${meaning}`;
  if (!warnedLanes.has(key)) {
    if (warnedLanes.size >= WARNED_LANES_CAP) warnedLanes.clear();
    warnedLanes.add(key);
    console.warn(
      `[task-board] no column on this board means "${meaning}", so ${what} ` +
        `will not happen — set the role on a column in the board's settings`,
    );
  }
  return false;
}

/**
 * This org's lanes, in one await.
 *
 * `(await boardLanes(ctx, org)).review` is what asking the long
 * way looks like, and almost every caller wants exactly this. Naming the
 * question is cheaper than reading the nesting.
 */
export async function boardLanes(
  ctx: StudioContext,
  organizationId: string,
): Promise<BoardLanes> {
  return await (await boardFor(ctx, organizationId)).lanes();
}

/** What this org's board runs when a card lands in `columnKey`, in one await.
 *  See {@link boardLanes}. */
export async function boardAutomationFor(
  ctx: StudioContext,
  organizationId: string,
  columnKey: string,
): Promise<ColumnAutomation | null> {
  return await (await boardFor(ctx, organizationId)).automationFor(columnKey);
}

/** This org's columns, in one await. See {@link boardLanes}. */
export async function boardColumnsOf(
  ctx: StudioContext,
  organizationId: string,
): Promise<BoardColumn[]> {
  return await (await boardFor(ctx, organizationId)).columns();
}

/**
 * The same board, for the callers that have no `StudioContext`.
 *
 * The projector wiring, the sweeper and the thread-finish reactions run with a
 * database handle and nothing else. Without this they would each have to be
 * TOLD which columns mean what, by whoever called them — and a caller that
 * forgot would silently reintroduce Studio's vocabulary on someone else's
 * board. Building the same handler from the same rows keeps one answer.
 */
async function boardForDb(
  db: Kysely<Database>,
  organizationId: string,
): Promise<BoardHandler> {
  const settings = await new OrganizationSettingsStorage(db).get(
    organizationId,
  );
  return boardHandler(organizationId, {
    automations: new ColumnAutomationStorage(db),
    boardColumns: new BoardColumnStorage(db),
    orgOwnedColumns: orgFlagEnabled(settings?.flags, "org_board_columns"),
  });
}

/** This org's lanes from a database handle. See {@link boardLanes}. */
export async function boardLanesForDb(
  db: Kysely<Database>,
  organizationId: string,
): Promise<BoardLanes> {
  return await (await boardForDb(db, organizationId)).lanes();
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
