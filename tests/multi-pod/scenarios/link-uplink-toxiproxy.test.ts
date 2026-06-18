/**
 * Multi-pod e2e: WS uplink resilience + publish-then-consume parity (spec §13/N4).
 *
 * This is the ONLY full-spine proof of the transport-layer-sync work — the WS
 * uplink + durable outbox + DECOPILOT_STREAMS publish + durable projector. It
 * cannot be a unit test (real NATS + Postgres + a link-daemon driving a
 * streaming turn + Toxiproxy chaos on the WS), so it lives here.
 *
 * ── PREREQUISITES (the bodies stay `test.skip` until these land) ─────────────
 * 1. tests/multi-pod/docker-compose.yml services:
 *      - `link-daemon`: runs the `bunx decocms@latest link` daemon against a mesh pod,
 *        env LINK_WS_UPLINK=true (dial GET /api/links/uplink). restart:"no" so
 *        pod.ts kill/start drives the outbox-replay-across-restart scenario.
 *      - `toxiproxy`: TCP proxy interposed on the uplink WS path (admin :8474)
 *        so a test can cut/restore the connection mid-turn.
 * 2. mesh pods started with the transport flags ON:
 *      - LINK_WS_UPLINK=true             (mount GET /api/links/uplink + handler)
 *      - LINK_PUBLISH_THEN_CONSUME=true  (raw-publish ingest, for the parity check)
 *      - LINK_DURABLE_PROJECTOR=true     (the standalone DB-writer)
 * 3. A streaming turn driver via mock-ai (already present): post a message that
 *    streams N chunks (e.g. "many:10" / "slow:20x500"), tail /stream + read
 *    thread_message_parts via dbQuery.
 *
 * The cluster-side spine is already unit-green on this branch (uplink frames,
 * ingest session w/ rolling ackSeq + resume + cancel, projector consumer,
 * outbox replay/truncate, daemon sender). What remains is the live socket +
 * the two docker services above; this file pins the assertions for them.
 */
import { describe, test } from "bun:test";
import { registerTestHooks } from "../lib/hooks";

registerTestHooks();

describe("link uplink — WS resilience + publish-then-consume parity", () => {
  // Flip LINK_PUBLISH_THEN_CONSUME=true and assert the durable projector writes
  // the SAME thread_message_parts the legacy inline path did (byte-for-byte
  // parts: kinds, text, deterministic ${runId}:${messageId}:${seq} ids).
  test.skip("[parity] publish-then-consume yields identical thread_message_parts", () => {});

  // Drive a slow turn, cut the uplink WS via Toxiproxy mid-stream, restore it,
  // and assert the daemon resumes from ackSeq with no gap/dupe (the cluster
  // dedupes by wireSeq; the outbox replays the unacked tail).
  test.skip("[resilience] WS uplink cut mid-turn resumes from ackSeq without gap/dupe", () => {});

  // SIGKILL the link-daemon mid-turn (pod.kill), restart it (pod.start), and
  // assert the bun:sqlite outbox replays the unacked prefix so the run completes.
  test.skip("[resilience] daemon restart replays the unacked outbox, completing the run", () => {});

  // Enqueue a relay carrying a STALE fence (a new run minted a fresh fence in
  // the DB); assert the uplink ingest hard-rejects it (close 1008 / error frame),
  // never a silent black hole (§10 fence coherence).
  test.skip("[coherence] a stale fence token is rejected loudly by uplink ingest", () => {});

  // Authorization parity with the NDJSON gate (the WS-uplink security fix): a
  // daemon authenticated as user A must NOT stream chunks into an org-B run
  // (close 1008 "run not authorized"), and a run with NO minted fence must
  // reject any chunk (null-fence guard). No cross-org WS ingest is otherwise
  // covered.
  test.skip("[authz] a foreign-org or unfenced run is rejected (close 1008)", () => {});

  // Inject an un-projectable chunk; assert the durable projector retries with
  // backoff, surfaces it (run marked failed via onDlq), and does NOT stall later
  // runs (poison isolation, §5.4).
  test.skip("[poison] an un-projectable chunk retries, DLQs, marks the run failed without stalling", () => {});
});
