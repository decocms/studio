/**
 * `board_column_transition` triggers: run an automation when a card enters a
 * board column.
 *
 * The board's own activity log is the event source. Every lane change records
 * a `status_changed` entry, whoever made it (a person dragging, a run, the
 * board opening a review), so reading those entries sees every move without
 * each writer having to publish one. A move fires once the card has RESTED in
 * the column for `SETTLE_MS`: a card dragged through a column on its way to
 * another, or dropped by mistake and moved straight back, starts nothing.
 *
 * Which moves a trigger answers, by where the card came from, is the same
 * shape the Jira column rules use (`jira/rule-from.ts`): any origin, an
 * earlier or later column in board order, or a list of columns.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { CANONICAL_COLUMN_KEYS } from "@decocms/shared/task-board";
import { normalizeFrom } from "@/jira/rule-from";
import type { AutomationTrigger } from "@/storage/types";
import { laneRank } from "@/tools/task-board/lanes";

/** How long a card must stay in a column before the move fires. The Jira
 *  trigger waits the same. */
export const SETTLE_MS = 20_000;

export const BoardColumnKeySchema = z.enum(CANONICAL_COLUMN_KEYS);

export const BoardTransitionFromSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("any") }),
    z.object({ kind: z.literal("earlier") }),
    z.object({ kind: z.literal("later") }),
    z.object({
      kind: z.literal("statuses"),
      statuses: z.array(BoardColumnKeySchema).min(1).max(20),
    }),
  ])
  .describe(
    "Which moves into the column count, by where the card came from: any " +
      "column, an earlier or later one in board order, or a list of columns.",
  );

export type BoardTransitionFrom = z.infer<typeof BoardTransitionFromSchema>;

/** The trigger's origin rule, from its columns. A stored column the board no
 *  longer has matches nothing. */
export function triggerFrom(
  trigger: Pick<AutomationTrigger, "from_kind" | "from_statuses">,
): BoardTransitionFrom {
  if (trigger.from_kind !== "statuses") {
    return { kind: trigger.from_kind ?? "any" };
  }
  const normal = normalizeFrom({
    kind: "statuses",
    statuses: trigger.from_statuses,
  });
  const stored = normal.kind === "statuses" ? normal.statuses : [];
  return {
    kind: "statuses",
    statuses: stored.flatMap((status) => {
      const key = BoardColumnKeySchema.safeParse(status);
      return key.success ? [key.data] : [];
    }),
  };
}

/** Does a move `from` → `to` fire this trigger? A move within one column
 *  never does. */
export function transitionMatches(
  trigger: Pick<
    AutomationTrigger,
    "column_key" | "from_kind" | "from_statuses"
  >,
  move: { from: string | null; to: string },
): boolean {
  if (trigger.column_key !== move.to) return false;
  if (move.from === move.to) return false;
  const from = triggerFrom(trigger);
  if (from.kind === "any") return true;
  if (move.from === null) return false;
  if (from.kind === "statuses") {
    return (from.statuses as readonly string[]).includes(move.from);
  }
  const earlier = laneRank(move.from) < laneRank(move.to);
  return from.kind === "earlier" ? earlier : !earlier;
}

/**
 * Where the card last RESTED before the move that settled: the newest move's
 * origin, unless the card only passed through it (stayed less than `settleMs`),
 * in which case the column before that, and so on. A card dragged Backlog →
 * QA → In Progress inside the window came from Backlog.
 *
 * `moves` is the card's lane changes, oldest first, ending with the settled
 * one.
 */
export function restedOrigin(
  moves: readonly { from: string | null; to: string; occurredAt: string }[],
  settleMs: number,
): string | null {
  let index = moves.length - 1;
  let origin = moves[index]?.from ?? null;
  while (index > 0) {
    const arrived = Date.parse(moves[index - 1]!.occurredAt);
    const left = Date.parse(moves[index]!.occurredAt);
    if (left - arrived >= settleMs) break;
    index -= 1;
    origin = moves[index]!.from ?? null;
  }
  return origin;
}

/** The automation's instruction: the text of its user messages. */
export function automationInstruction(messagesJson: string): string {
  const messages = z
    .array(
      z.object({
        role: z.string(),
        parts: z
          .array(z.object({ type: z.string(), text: z.string().optional() }))
          .optional(),
      }),
    )
    .catch([])
    .parse(JSON.parse(messagesJson));
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.parts ?? [])
    .flatMap((p) => (p.type === "text" && p.text ? [p.text] : []))
    .join("\n\n")
    .trim();
}

/** Deterministic run thread and workflow ids for one trigger's fire on one
 *  move, so a replayed fire lands on the run it already started. */
export function cardFireFence(
  triggerId: string,
  eventKey: string,
): { threadId: string; workflowID: string } {
  const key = `automation:${triggerId}:${eventKey}`;
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return { threadId: `thrd_${digest}`, workflowID: key };
}
