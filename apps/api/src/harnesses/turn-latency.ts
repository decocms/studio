/**
 * Where a chat turn's time to first token goes, as `[turn-latency]` log lines:
 * one per stage (ms since the message POST, and since the previous stage), then
 * a one-line breakdown when the first token arrives.
 *
 * ponytail: in-process clock keyed by thread id. When the run executes on a
 * different pod than the POST, its clock starts at that pod's first stage
 * (`t0=local`); carry the POST time on the durable request if that matters.
 */

interface Turn {
  t0: number;
  last: number;
  stages: string[];
}

// On globalThis: `bun --hot` reloads leave DBOS running the old module graph.
const turns: Map<string, Turn> = ((
  globalThis as { __turnLatency?: Map<string, Turn> }
).__turnLatency ??= new Map());
const MAX_TURNS = 500;

/** Run ids are `<threadId>:<fence>`; the clock is per thread. */
const threadOf = (id: string): string => id.split(":")[0] ?? id;

/** Start a turn's clock: the message POST arrived. */
export function startTurnClock(threadId: string): void {
  if (turns.size >= MAX_TURNS) {
    const oldest = turns.keys().next().value;
    if (oldest !== undefined) turns.delete(oldest);
  }
  const now = Date.now();
  turns.delete(threadId);
  turns.set(threadId, { t0: now, last: now, stages: [] });
  console.log(`[turn-latency] thread=${threadId} stage=post-received +0ms`);
}

export function markTurn(
  id: string,
  stage: string,
  extra?: Record<string, unknown>,
): void {
  const threadId = threadOf(id);
  const now = Date.now();
  let turn = turns.get(threadId);
  const local = !turn;
  if (!turn) {
    turn = { t0: now, last: now, stages: [] };
    turns.set(threadId, turn);
  }
  const total = now - turn.t0;
  const delta = now - turn.last;
  turn.last = now;
  turn.stages.push(`${stage}=${delta}`);
  console.log(
    `[turn-latency] thread=${threadId} stage=${stage} +${total}ms (Δ${delta}ms)` +
      (local ? " t0=local" : "") +
      (extra ? ` ${JSON.stringify(extra)}` : ""),
  );
}

/** First token reached Studio: log the breakdown and drop the clock. */
export function endTurnClock(
  id: string,
  extra?: Record<string, unknown>,
): void {
  const threadId = threadOf(id);
  markTurn(threadId, "first-token", extra);
  const turn = turns.get(threadId);
  if (!turn) return;
  turns.delete(threadId);
  console.log(
    `[turn-latency] thread=${threadId} SUMMARY ttft=${turn.last - turn.t0}ms ${turn.stages.join(" ")}`,
  );
}
