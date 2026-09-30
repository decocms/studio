/**
 * Where an issue came to rest, read off its status history.
 *
 * A person dragging a card through a column on the way to another, or into
 * the wrong column and straight back, fires a transition per drop. Reacting to
 * each one runs the column's agent on a card that never stayed there, and a
 * run started for one drop supersedes the run the card was really waiting on.
 * So a rule reacts to where the card RESTED instead: a status it stayed in for
 * `SETTLE_MS`, reached from the last status it had also stayed in.
 *
 * Derived from Jira's own history, not from anything Studio recorded, so the
 * webhook and the poll reach the same answer about the same change, and a
 * transition Studio never heard of still counts.
 */

import type { JiraStatusChange } from "./client";

/** How long a card must stay in a status before a rule reacts to it. */
export const SETTLE_MS = 60_000;

export type Settled =
  /** A newer move than the one asked about exists; that one decides. */
  | { kind: "superseded" }
  /** The latest move is younger than `SETTLE_MS`: the card may still move. */
  | { kind: "moving" }
  /** It moved away and back without resting anywhere else. Nothing happened. */
  | { kind: "returned"; change: JiraStatusChange }
  | {
      kind: "moved";
      /** The move that put it where it rests; its id is what a run claims. */
      change: JiraStatusChange;
      /** The last status it rested in before, with its id when Jira gave one. */
      from: { id: string | null; name: string | null };
    };

/**
 * `changes` oldest first. `changeId` names the move a caller is asking about
 * (the webhook's); without it, the latest move is the question (the poll's).
 * `now` is omitted by a caller that already waited `SETTLE_MS` itself, which
 * trusts that wait over a clock compared with Jira's.
 */
export function settle(
  changes: readonly JiraStatusChange[],
  opts: { changeId?: string; now?: number },
): Settled | null {
  const latest = changes.at(-1);
  if (!latest) return null;
  if (opts.changeId !== undefined && latest.id !== opts.changeId) {
    return { kind: "superseded" };
  }
  if (opts.now !== undefined && opts.now - latest.at < SETTLE_MS) {
    return { kind: "moving" };
  }
  const from = restedBefore(changes);
  const back = from.id && latest.toId ? from.id === latest.toId : false;
  if (back || (!from.id && from.name === latest.to)) {
    return { kind: "returned", change: latest };
  }
  return { kind: "moved", change: latest, from };
}

/** The status the card last stayed in for `SETTLE_MS` before its latest move.
 *  The status it was created in counts as rested: nothing came before it. */
function restedBefore(changes: readonly JiraStatusChange[]): {
  id: string | null;
  name: string | null;
} {
  for (let i = changes.length - 2; i >= 0; i--) {
    const entered = changes[i];
    const left = changes[i + 1];
    if (entered && left && left.at - entered.at >= SETTLE_MS) {
      return { id: entered.toId, name: entered.to };
    }
  }
  const first = changes[0];
  return { id: first?.fromId ?? null, name: first?.from ?? null };
}
