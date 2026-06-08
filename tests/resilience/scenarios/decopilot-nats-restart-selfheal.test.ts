/**
 * Resilience scenario: stream-of-record (v2) self-heal across a NATS restart.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * What this proves (the stream-of-record guarantee)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The chat return path has THREE independent channels (see the chat-dataflow
 * design): (1) the live JetStream delta tail, (2) the durable
 * `thread_message_parts` rows, and (3) the client's history re-fetch on
 * reconnect. The accepted **B2** regression is that when NATS drops
 * mid-stream the live deltas (channel 1) are lost — a client tailing the
 * stream sees it cut off. The **C1 / B1 / B4** self-heal guarantee is that
 * the *result still survives* in Postgres (channel 2): the v2 write path
 * persists each final part to `thread_message_parts` at `onStepFinish` /
 * `onFinish` plus a `'finish'` anchor row, INDEPENDENTLY of NATS. So when the
 * client reconnects and re-folds the parts (channel 3 → `foldParts`), it
 * renders the COMPLETE message with `status: "complete"` — never a
 * truncated-as-final fragment.
 *
 * This scenario drives a real v2 streaming chat turn, severs NATS mid-stream
 * via Toxiproxy, restores it, and asserts:
 *
 *   1. A `'finish'` part row for the assistant message lands in the
 *      containerized Postgres (`thread_message_parts`) — proving the durable
 *      channel survived the NATS outage.
 *   2. `foldParts(rows)` yields the assistant message with
 *      `status: "complete"` and a non-empty `parts` array — proving the
 *      reconnect renders the complete message, not a truncated fragment.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * FEASIBILITY (2026-06-05): the turn-driving steps are `test.skip`ped.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Driving an end-to-end v2 streaming chat turn requires harness scaffolding
 * the resilience compose does NOT have today. See
 * `decopilot-nats-restart-selfheal.README.md` for the full gap list and the
 * port plan. In short, three things are missing:
 *
 *   1. **No model provider.** The resilience `docker-compose.yml` has no
 *      `mock-ai` service. `streamText` (and tier resolution) need an
 *      OpenAI-compatible endpoint to stream deltas from. The multi-pod suite
 *      has exactly this (`tests/multi-pod/mock-ai/server.ts`).
 *   2. **No v2 env.** The `studio` service has no `STREAM_OF_RECORD_V2_PERCENT`,
 *      so every new thread stays `message_storage_version=1` and NO parts are
 *      ever written. The turn must run with `STREAM_OF_RECORD_V2_PERCENT=100`.
 *   3. **Dispatch 409s.** `studio` runs with `STUDIO_SANDBOX_PROVIDER=user-desktop`
 *      and the `link-daemon` is behind a compose profile (not started by
 *      `up --wait`). With no link claim, `resolveDispatchTarget` returns
 *      `user_desktop_link_offline` and `POST /messages` 409s before any
 *      dispatch. The turn must run with `STUDIO_SANDBOX_PROVIDER=cluster` (as
 *      the multi-pod suite does) so dispatch short-circuits to the cluster
 *      default and the mock-ai stream runs without a sandbox.
 *
 * The toxiproxy / poll / Postgres-query wiring below is REAL and runnable —
 * `dbQuery` shells into the compose `postgres` service exactly like
 * `tests/multi-pod/lib/db.ts`, and the fold-and-assert helper imports the
 * production `foldParts`. Only the steps that need a streaming turn are
 * skipped. When the harness gains the three pieces above, delete the
 * `test.skip` (and drive the turn via the `driveV2Turn` outline in the
 * README) and this scenario runs as-is.
 */

import { describe, expect, test } from "bun:test";
// Relative import (NOT the `@/` alias): the `@/` path is defined only inside
// the apps/mesh workspace tsconfig, and these resilience scenarios live
// outside it. The headless link-daemon entrypoint reaches into app code the
// same way (see ../link-daemon-entrypoint.ts).
import {
  foldParts,
  type ThreadMessagePart,
} from "../../../apps/mesh/src/storage/fold-parts";
import { registerTestHooks } from "../lib/setup";
import { disableProxy, enableProxy } from "../lib/toxiproxy";
import { PROXY_NAMES } from "../lib/toxic-presets";
import { pollUntil } from "../lib/poll-until";

registerTestHooks();

// ──────────────────────────────────────────────────────────────────────────
// Real DB wiring — shells into the compose `postgres` service (no host port
// is exposed for it), mirroring tests/multi-pod/lib/db.ts. This is the
// channel-2 observation the scenario hinges on.
// ──────────────────────────────────────────────────────────────────────────

const COMPOSE_FILE = new URL("../docker-compose.yml", import.meta.url).pathname;

/**
 * Run a query against the containerized Postgres and return rows as objects.
 * `json_agg` is used so each row is a single JSON cell — that sidesteps the
 * naive comma-splitting CSV parser entirely and lets us round-trip the
 * `payload` jsonb column faithfully.
 */
async function dbQueryJson<T>(sql: string): Promise<T> {
  const proc = Bun.spawn(
    [
      "docker",
      "compose",
      "-f",
      COMPOSE_FILE,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-t", // tuples only (no header / row-count footer)
      "-A", // unaligned (no padding)
      "-c",
      sql,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`dbQueryJson failed (exit ${code}): ${stderr || stdout}`);
  }
  const trimmed = stdout.trim();
  return (trimmed ? JSON.parse(trimmed) : null) as T;
}

/**
 * Load every `thread_message_parts` row for a thread, ready to hand to the
 * production `foldParts`. Ordered by seq for readability; `foldParts` is
 * order-independent so this is purely cosmetic.
 */
async function loadParts(threadId: string): Promise<ThreadMessagePart[]> {
  const rows = await dbQueryJson<ThreadMessagePart[] | null>(
    `SELECT COALESCE(json_agg(t ORDER BY t.seq), '[]'::json)
       FROM thread_message_parts t
      WHERE t.thread_id = '${threadId.replace(/'/g, "''")}'`,
  );
  return rows ?? [];
}

/** True once the thread has a `'finish'` part for an assistant message. */
async function hasAssistantFinish(threadId: string): Promise<boolean> {
  const parts = await loadParts(threadId);
  return parts.some((p) => p.kind === "finish" && p.role === "assistant");
}

describe("decopilot — stream-of-record self-heal across NATS restart", () => {
  // ────────────────────────────────────────────────────────────────────────
  // Runnable now: the durable-channel observation wiring itself.
  //
  // Proves `dbQuery` + `foldParts` are correctly wired against the
  // containerized Postgres, so the moment the turn-driving lands the
  // assertions are trustworthy. An empty thread has no parts, which folds to
  // an empty message list — exactly what we expect before any turn runs.
  // ────────────────────────────────────────────────────────────────────────
  test("durable-channel query + fold wiring is live (no turn)", async () => {
    const emptyThreadId = `thrd_selfheal_probe_${crypto.randomUUID()}`;
    const parts = await loadParts(emptyThreadId);
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.length).toBe(0);

    const folded = foldParts(parts);
    expect(folded).toEqual([]);
    console.log("  → dbQuery + foldParts wiring verified against compose pg");
  }, 30_000);

  // ────────────────────────────────────────────────────────────────────────
  // The actual self-heal proof. SKIPPED until the harness can drive a v2
  // streaming chat turn (see file header + README for the three missing
  // pieces). The body is intentionally complete so that un-skipping it — once
  // `mock-ai` + `STREAM_OF_RECORD_V2_PERCENT=100` + `STUDIO_SANDBOX_PROVIDER=cluster`
  // are wired — runs the real assertion with no further edits beyond
  // implementing `driveV2Turn` (outlined in the README).
  // ────────────────────────────────────────────────────────────────────────
  test.skip("NATS drops mid-stream → result survives in thread_message_parts → reconnect renders COMPLETE message", async () => {
    // TODO(task-10-harness): requires (a) a `mock-ai` service in
    // tests/resilience/docker-compose.yml, (b) `STREAM_OF_RECORD_V2_PERCENT=100`
    // and `STUDIO_SANDBOX_PROVIDER=cluster` on the `studio` service, and
    // (c) a `driveV2Turn` helper that bootstraps a provider/agent/thread and
    // POSTs a streaming message. See the README for the full port plan and
    // the `driveV2Turn` signature.
    //
    // const { threadId } = await driveV2Turn({
    //   // A multi-chunk, slow stream so we have a window to sever NATS
    //   // mid-flight (mock-ai hint, see tests/multi-pod/mock-ai/server.ts).
    //   prompt: "slow:20x500",
    // });

    const threadId = "<provided by driveV2Turn>";

    // 1. Wait until the stream is visibly flowing (first non-finish part
    //    persisted) — proves the turn started before we inject the fault.
    await pollUntil(
      async () => {
        const parts = await loadParts(threadId);
        return parts.some((p) => p.role === "assistant" && p.kind !== "finish");
      },
      {
        timeoutMs: 30_000,
        intervalMs: 500,
        label: "v2-stream-flowing-before-nats-drop",
      },
    );

    // 2. B2: sever NATS mid-stream. Live deltas (channel 1) are now lost —
    //    a client tailing /stream sees it cut off. We do NOT assert on the
    //    live tail here; the whole point is that the DURABLE channel heals.
    await disableProxy(PROXY_NAMES.NATS);

    // Hold the outage long enough to span the rest of the stream's deltas.
    await Bun.sleep(6_000);

    // 3. Restore NATS (the "restart"). The worker reconnects; the durable
    //    write path was never gated on NATS, so parts kept landing in PG.
    await enableProxy(PROXY_NAMES.NATS);

    // 4. C1 / B1 / B4: the assistant message's `'finish'` anchor must
    //    appear in `thread_message_parts` — the run completed durably
    //    despite the NATS outage.
    await pollUntil(() => hasAssistantFinish(threadId), {
      timeoutMs: 60_000,
      intervalMs: 1_000,
      label: "assistant-finish-part-persisted",
    });

    // 5. Fold the durable rows exactly as the reconnect read path does and
    //    assert the assistant message is COMPLETE with real content — never
    //    truncated-as-final.
    const parts = await loadParts(threadId);
    const folded = foldParts(parts);
    const assistant = folded.find((m) => m.role === "assistant");

    expect(assistant).toBeTruthy();
    expect(assistant!.status).toBe("complete");
    expect(assistant!.parts.length).toBeGreaterThan(0);
    console.log(
      `  → assistant message folded COMPLETE with ${assistant!.parts.length} part(s) after NATS restart`,
    );
  }, 120_000);
});
