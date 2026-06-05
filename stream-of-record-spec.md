# Spec — Stream-of-Record (axis c), revised

**Status:** Draft for review · **Companion to:** [`proposals.md`](proposals.md) (axis c) and [`report.md`](report.md) (issue catalog `A1`–`I1`).

This spec **revises** the "Stream-of-record (axis c)" design that `proposals.md` calls *settled and engine-agnostic*. It keeps the same goal — collapse the three return channels into one cursor-addressed record of truth — but changes **what gets persisted where**, based on a key observation the original glossed over: **streamed token-deltas are transient, non-critical data, and do not belong in the durable store.**

It is engine-agnostic (Temporal / Restate / DBOS / pure-K8s all sit on top of it unchanged) and is still the **first thing to build**, before any control-plane decision.

---

## 1. TL;DR — the one change

> **Split the log by durability.** Postgres `thread_message_parts` stores only **completed message parts** (text, tool calls/results, errors + a per-message `finish` marker) — **a handful of rows per message**, not one per token; status stays on `threads`. **Streamed token-deltas live only in NATS**, a transient, loss-tolerant live edge (in-memory, but **kept sharded per-org**). The durable result is never lost (each part is a durable append); the live *stream* is best-effort and **self-heals** when the durable parts land. Heavy payloads are offloaded by **claim-check**. `thread_messages` is **not written for new (v2) threads** — it's the **frozen v1 archive**; v2 reads **fold the parts on read** (windowed, `LIMIT/OFFSET` over one-per-message anchors), so there's no projection to maintain and no dual-write. Threads migrate by **versioning** (strangler-fig), never a big-bang rewrite. Liveness is a cheap, periodically-bumped **`last_progress_at`** timestamp.

This trades **one property** away — live-stream completeness during a NATS hiccup — for **near-zero Postgres write amplification**, **operational simplicity** (memory NATS is fine), and a record of truth back at **message-scale** (a small multiple of `thread_messages`, not token-scale).

---

## 2. What changes vs. the current `proposals.md` axis-c

The current `proposals.md` text (verbatim) says *"Every UI chunk, tool call, status transition, and the final message is **one append** … no `% 5` sampling"* with a *"JetStream-persistent (R3, file-backed), sharded"* edge and *"One cursor = `seq`"*. The deltas:

| Aspect | Current `proposals.md` axis-c | **Revised (this spec)** |
|---|---|---|
| **What `thread_message_parts` stores** | every UI chunk **+** tool call **+** status **+** final | **completed message parts only** — text, tool calls/results, reasoning, errors + a per-message `finish` marker. **No token-deltas; no status rows (status stays on `threads`).** |
| **`thread_message_parts` cardinality** | ~1 row per chunk (≈100× messages) | a few part-rows per message (text + tool-call/result + `finish`) — single-digit× `thread_messages`, not ~100× |
| **Streamed deltas** | durable log **and** live edge | **NATS live edge only** — transient, loss-tolerant |
| **Live-edge storage** | JetStream **persistent R3, file-backed**, sharded | **In-memory, ~5 min, single-replica** (cost tradeoff) **but kept sharded per-org** `CHAT.<shard>.<org>.>` (§3.2) |
| **Cursor** | one unified `seq` | **two-tier**: durable `thread_message_parts.seq` + NATS live sequence (deltas), handoff at completion (§3.5) |
| **Heavy payloads** | inline `payload` column | **claim-check**: payloads > threshold → object storage, row holds a pointer (§3.4) |
| **`thread_messages`** | "becomes a fold projection" | **frozen v1 archive — not written for v2**; v2 reads fold `thread_message_parts` on read (windowed, `LIMIT/OFFSET` over one-per-message anchors); one loader branches v1/v2 (§3.6) |
| **Pagination cursor** | (unspecified) | request-supplied `LIMIT/OFFSET`; **`context_start_message_id` not used** (orthogonal LLM-context feature) |
| **Migration** | unspecified | **thread versioning** (strangler-fig): v2 → `thread_message_parts`, v1 **frozen** on `thread_messages` (§3.7) |
| **Liveness** | progress reaper on `last_progress_at` | a cheap, throttled `last_progress_at` timestamp bump on delta arrival (§3.8) |

The honest headline: `proposals.md` rated the **B-class a near clean-sweep ✅**. This revision **downgrades the *restart/loss* parts of the B-class to 🟡** (live deltas can be lost), while **upgrading the C-class** (the *result* is now genuinely durable) and **keeping the cross-org isolation** (sharding retained). We trade live-stream completeness for write-volume and operational simplicity, eyes open. See §5–§6.

---

## 3. The design

### 3.1 Durability split — message parts vs. deltas

Two kinds of data, two stores, two lifetimes:

- **Durable message parts → Postgres `thread_message_parts` (permanent).** Each *completed* **part** of a message — a text part, a tool-call, a tool-result, a reasoning part, an error, plus a tiny per-message `finish` marker — is **one idempotent append**. The final assembled message is simply the **fold of its parts**; there is no separate "final" mega-row, so `C1` is satisfied *per part*. (Run/turn status stays on `threads.status`; step boundaries are **not** rows — see the decisions table.)
- **Token-deltas → NATS only (transient, loss-tolerant).** The streamed `text-delta`/`tool-input-delta`/reasoning chunks are published to the live edge and **never written to Postgres**. They make the live view smooth and mid-stream-resumable; they are non-critical because each completed part is a durable row.

Schema — **`thread_message_parts`** (formerly `run_events` in `proposals.md`; renamed to fit the `thread_*` convention and avoid colliding with the event-bus `events`/`event_deliveries` tables):

```sql
thread_message_parts (
  id           text   PRIMARY KEY,   -- "<run_id>:<seq>"; idempotent via ON CONFLICT (id) DO NOTHING (R8)
  seq          bigint NOT NULL,      -- monotonic per run; the protocol cursor + intra-run order  (UNIQUE (run_id, seq))
  org_id       text   NOT NULL,      -- tenant scope: partition pruning, per-org authz (R23), claim-check key prefix
  thread_id    text   NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  run_id       text   NOT NULL,      -- the turn (taskId/workflowID) this part belongs to
  message_id   text   NOT NULL,      -- groups parts into one logical message → folds to thread_messages.id
  role         text   NOT NULL,      -- 'user' | 'assistant' | 'system'
  kind         text   NOT NULL,      -- 'text' | 'reasoning' | 'tool_call' | 'tool_result' | 'file' | 'error' | 'finish'
  payload      jsonb  NOT NULL,      -- the part content inline, OR a claim-check pointer when offloaded (§3.4)
  payload_ref  text,                 -- non-null when payload lives in object storage (durable object key)
  metadata     jsonb,                -- optional: provider metadata / token usage (assistant's last part)
  created_at   text   NOT NULL       -- ISO; display + cross-run order; derived monotonic, NOT now+i
                                      -- APPEND-ONLY: rows are immutable → no updated_at
)
```

Indexes: `PRIMARY KEY (id)`; `UNIQUE (run_id, seq)` (cursor + intra-run order + reconnect backfill `WHERE run_id=? AND seq > cursor`); `(thread_id, created_at, id)` (read/fold order, mirrors the existing `idx_thread_messages_thread_created_id`). **Partition by `created_at`** (time-range) for O(1) retention via `DROP PARTITION`.

**Modeling decisions** (why these columns):

| Decision | Why |
|---|---|
| Keep **both `seq` (per-run int) and `created_at`** — not redundant | `created_at` = human time + cross-run display order. `seq` = the per-run **protocol cursor**, and a timestamp can't do its job: it **collides** at sub-ms (the codebase already needs an `id` tiebreak on `thread_messages`), it goes **backwards on resume across pods** (that *is* `C5`), and gap-arithmetic needs **contiguous integers**. `seq` continued from `MAX(seq)` is monotonic by construction → the structural `C5` fix. |
| **No `step_index`** | Step boundaries are semantic (harness `onStepFinish`), **not** inferable from `created_at` (a time gap ≠ a step) — but also not needed by the record layer: the fold groups by `message_id`, and `C2` "don't re-run a completed tool" is handled by **tool-call-id dedup**. Steps are a dispatch/resume concern; add a column later only if resume needs it. |
| Two keys: **`id`** (per-row idempotency) vs **`message_id`** (grouping) | `id = <run>:<seq>` is unique per row for `ON CONFLICT`; `message_id` groups the parts that fold into one `thread_messages` row. |
| Rows are **parts**, not deltas, not one "final" blob | Each part is durable when it completes; the message = fold of its parts; a tiny `finish` part marks per-message completion. `C1` holds per-part; no waiting on a single final row. Deltas stay in NATS. |
| **Status stays on `threads.status`**; append-only ⇒ **no `updated_at`** | Status is already a durable `threads` column; immutability is the point (it's why this fixes `C1`/`C2`/`C5`). `thread_messages` keeps its `updated_at` because *it* is the upserted projection. |
| **`org_id` denormalized** (unlike `thread_messages`) | High-volume partitioned table: partition pruning, the per-org authz predicate (`R23`), and the claim-check `<orgId>/` key. |

### 3.2 Deltas in NATS only — memory-only **but sharded per-org**

The live edge stays JetStream and **accepts the in-memory config** (`StorageType.Memory`, `max_age` 5 min, `num_replicas: 1`; `nats-stream-buffer.ts:98–108`). A delta only needs to outlive the run for live viewing, and losing it degrades *streaming smoothness*, never the *result*.

**Retention and sharding are independent axes — we relax only retention.** We keep the `proposals.md` **sharded per-org subjects** `CHAT.<shard>.<org>.>` (a fixed pool of N subjects, orgs hashed to shards). Memory-only retention is the cost win; sharding is the **cheap isolation we do not give up**:

- Per-org/per-shard subjects mean a noisy org's delta firehose evicts **only its own shard**, not every tenant's live edge — closing `B3` without paying for R3.
- Per-shard subjects are the unit that NATS-account ACLs can later scope, keeping a path to `H2`.
- Browser tails remain cheap **ephemeral** (non-RAFT) filtered consumers, not HA assets — so we stay well under NATS's ~2k-HA-asset ceiling even sharded.

**The one residual we accept:** a full NATS restart still wipes all in-memory subjects at once (`B2`) — in-flight deltas are lost and recover when the next durable part lands. Sharding does **not** fix restart-loss; only file-backed R3 would, and we are choosing not to pay for it. The result is always safe (durable parts); only live smoothness degrades during the restart window.

### 3.3 Self-healing liveness + the client contract

On any delta loss (eviction, NATS restart, sequence gap), the in-flight message may render **incomplete** until it finalizes; when its durable parts land in Postgres, the client reloads and the message becomes whole. The visible glitch is bounded by **part frequency** (deltas lost since the last durable part — at most one step's worth).

**Mandatory client behavior** (non-negotiable even though retention is lax):
1. **Reconcile to durable, keyed by `message_id`.** A durable part **unconditionally replaces** any live-accumulated partial with the same `message_id`, regardless of arrival order. The live partial **reuses the durable `message_id`** so the durable fold overwrites it in place.
2. **Detect gaps explicitly; never present a truncated partial as finished.** A missing sequence → backfill from Postgres if covered by a durable part, else render the partial **as in-progress** and reload on the next part. Closes `B4`.
3. **Completion is signalled by the durable record, not the live buffer.** If `threads.status` is terminal but the message's `finish` part isn't visible yet, refetch Postgres until it is.

### 3.4 Heavy payloads — claim-check to object storage

Payloads over a size threshold (large tool results, attachments, large finals) go to object storage; the part row stores **metadata + a pointer**. Small payloads stay inline.

- **Reuse the mechanism, upgrade the lifecycle.** The codebase already offloads large dispatch bodies via `messagesRef` (`harnesses/remote-dispatch.ts`, `object-storage/{s3-service,bound-object-storage,key-utils}.ts`, AWS SDK v3) — **but that path is transient** (600 s presigned TTL, `dispatch-run.ts:985`; *no working bucket lifecycle rule*, orphans leak on abort, `ensure-services.ts:823`). Claim-checked **part** objects must live in a **durable, backed-up, retention-managed** bucket bound to the referencing rows.
- **Write order: object PUT (confirmed) → then commit the row.** A committed row never points at a missing object; a PUT whose row never commits is a harmless orphan for GC.
- **Delete order: row/partition first → then GC the object.** Never delete an object a live row still references.
- **Isolation:** at minimum preserve the existing `<orgId>/…` key prefix (today's only tenant boundary, `key-utils.ts:44`); bucket-level isolation is the stronger target (`E3`).
- **Optional:** hand the browser **signed URLs** for big blobs so they never round-trip the API.

### 3.5 Two-tier cursor

There is no longer one unified `seq`. The durable history and the live edge count different things:

- **Postgres (durable) cursor** = last applied `thread_message_parts.seq`.
- **NATS live cursor** = last JetStream sequence.

**Read-tier selection mirrors the existing `deliverPolicy` logic** (`routes.ts:722`, `thread.status === "in_progress" ? "all" : "new"`): on (re)connect the client reads the authoritative `threads.status`; if `in_progress`, it drains Postgres `seq > pg_cursor` to the durable head **then** tails NATS; if terminal, it loads the parts from Postgres and opens **no** tail. The completion handoff is the sharp edge — see R3/R4 in §8.

### 3.6 Reads — fold-on-read; `thread_messages` is the frozen v1 archive

For **v2 threads, `thread_messages` is never written.** The single write target is `thread_message_parts` (append-only); `thread_messages` is the **frozen v1 archive** — it stops growing, is never synced, and is never deleted (§3.7). There is **no maintained projection**, so there is **no dual-write and no cache-staleness** — a pure fold-on-read is always fresh.

- **One read loader, two backends.** A single `loadMessages(thread, window)` branches on thread version: **v1 → query the frozen `thread_messages`** (today's `listMessages`); **v2 → windowed fold of `thread_message_parts`**. Every caller (UI list, exports, search) goes through this one function, so the v1/v2 fork lives in exactly one place — the common message-shape interface (§3.7).
- **Bounded windowed fold (v2).** A read returns the last N **messages**, folded from their parts. The per-message anchor is the **one-per-message `finish` row**, so "last N messages" is `WHERE thread_id=? AND kind='finish' ORDER BY created_at DESC, id LIMIT N OFFSET M` → fetch those `message_id`s' parts → fold. **`LIMIT/OFFSET` stays adequate** (one anchor row per message ⇒ offset depth bounded by message count), with `(created_at, id)` ordering hardened to the **durable order** (`C5` fix). Keyset is the optional later hardening for live-thread offset-drift. The **whole-thread fold is forbidden** on the hot path; `context_start_message_id` is not used.
- **The sidebar never folds.** Thread-list reads hit `threads` via `idx_threads_org_hidden_updated`. No message access (v1 or v2).
- **Rebuild is recovery/migration only** (corruption, schema change, the v1→v2 upgrade). An *optional* lazy read-cache — **separate from `thread_messages`** — may be added later **only if** fold CPU shows up; it is never a write-path obligation.

### 3.7 Migration — thread versioning (strangler-fig)

We cannot big-bang migrate 9.4 GB of `thread_messages` (92% of the DB), and a continuously-synced projection is a bug factory. So:

- **Version each thread.** New threads are **v2** (read+write `thread_message_parts`). Old threads are **v1** (read frozen `thread_messages`). There is **no `version` column today** — add one. The proven precedent to copy is the **pin-on-first-message + tolerant-reader** pattern already used for `sandbox_provider_kind`/`harness_id` (migration 086): nullable column, lazily set on first touch, readers tolerate both.
- **Continued old threads → upgrade-on-touch.** On a v1 thread's first new turn, synthesize **final-only** `thread_message_parts` rows from its `thread_messages` (preserving `id`/`role`/`parts`/timestamps/order), mark it v2, then it's pure-v2. Preferred over permanent union reads.
- **Freeze, never delete `thread_messages`.** It stops growing and stops being synced; cold rows sit at 100% cache hit, harmless. A lazy background backfill can retire the tail later — optional, never on the critical path.
- **Discipline:** scope the version to *message storage* only; put both readers behind one common message-shape interface so feature code doesn't fork; cut over at **turn boundaries**; canary by % of new threads.

### 3.8 Liveness — a cheap progress timestamp

Liveness is **not** a part and **not** a `thread_message_parts` row. It is a throttled bump of `threads.last_progress_at` (a HOT timestamp `UPDATE`, no content, no TOAST churn) on delta arrival, rate-limited to ~once per few seconds. This:

- Gives the progress-based reaper a real signal (`A1`/`A2`/`A4`): "alive" = progress is advancing; "stuck" = no progress past an idle deadline — independent of absolute age, with no `startedAt` for a resume to game.
- Costs effectively nothing (one indexed timestamp update, no write amplification) and **does not reintroduce deltas into Postgres**.
- Keeps the self-heal glitch bound at "one step's worth of deltas" (§3.3) — the user-accepted tradeoff — while still detecting a wedged step that emits no parts.

---

## 4. Requirements satisfied

The ten axis-c requirements from `proposals.md` still hold, with one explicitly relaxed:

- ✅ Async turn model, durable per-thread record, hours-long sessions (progress liveness), human-in-the-loop, runs on K8s, testability (fold + cursor logic is pure and unit-testable; no engine needed), **multi-tenancy/fairness on the live edge (sharding retained)**.
- 🟡 **Resumable live stream — relaxed to "resumable *result*, best-effort *stream*."** Reconnect always recovers the durable history and tails live from the current position; it does **not** guarantee gap-free replay of in-flight deltas across a NATS restart. The deliberate trade.

---

## 5. What this SOLVES

Per-issue verdict (✅ Solved · 🟡 Partial · ⬜ Untouched · ❌ Worse):

| Issue | Verdict | Why |
|---|---|---|
| **C1** final message can vanish | ✅ | Every part — including the per-message `finish` marker — is a durable, idempotent append (`ON CONFLICT (id) DO NOTHING`), committed independently of NATS; a message can't be left partial. |
| **C2** sampled saves → lost work / dup side-effects | ✅ | Every tool call, result, and text part is its own durable append; the every-5th-step sampling is gone. |
| **C5** synthetic timestamps reorder on resume | ✅ | Order is per-run `seq` + `created_at` derived from the durable part order, not `now+i`. |
| **A1** 30-min reaper kills long runs | ✅ | `last_progress_at`-based liveness (§3.8) replaces the absolute-age reaper. |
| **A2** resume-loop reaper evasion lockout | ✅ | No resettable `startedAt`; liveness = progress, not age. |
| **B3** global-cap cross-org eviction | ✅ | **Per-org sharded subjects** (retained, §3.2) bound eviction to the noisy org's own shard. |
| **A4** no idle timeout after first chunk | 🟡 | `last_progress_at` supplies the idle signal; enforcing the idle-timeout/freeing the gate is dispatch-layer (out of scope here). |
| **B1** 5-min ephemeral stream | 🟡 | The *answer* survives past 5 min (durable part) and self-heals on reload; the *live stream* is still ephemeral, now loss-tolerant by design. |
| **B2** in-mem + 1-replica loss on NATS restart | 🟡 | Result survives (Postgres); in-flight **deltas are still lost** on restart, recovering when the next durable part lands. **Deliberately not fixed** (memory-only accepted). |
| **B4** silent ordered-consumer gap | 🟡 | Mandatory gap detection + reload-from-Postgres forbids truncated-as-final; deltas are still genuinely lost (glitch ≤ one step). |
| **B5** swallowed pump failures | 🟡 | Part-append failures are durable/observable on reload; per-delta publishes stay fire-and-forget and need a metric (§6). |
| **C6** FINISH+purge+SSE not atomic | 🟡 | Each part is durable-first and idempotent, but finish composes Postgres + NATS purge + object PUT via ordering rules (R3), not one atomic txn. |
| **D3** NATS SPOF / silent degradation | 🟡 | History/result survive NATS being down; dispatch/heartbeats/live-streaming still depend on NATS. |
| **E3** shared offload bucket | 🟡 | Upgraded to a durable retention-managed bucket with PUT-before-commit; isolation still `<orgId>/` key-prefix, not bucket-level. |
| **H2** NATS subjects rely on network isolation | 🟡 | Sharded per-org subjects make per-org NATS-account ACLs *possible* (the scoping unit now exists); ACL enforcement itself is a separate NATS-account change. |

---

## 6. What this DOES NOT solve (and one accepted regression)

Honest scope boundaries — out of scope/untouched, plus one conscious step backward. *(From the adversarial review.)*

- ⬜ **`A5`/`C3` desktop-death continuity (HIGH).** Untouched. Recovery still **re-runs** the turn; no re-attach, no workdir fence. Worse: part-granularity persistence **widens the re-run replay window** vs. per-chunk — on crash, everything since the last durable part is replayed. The daemon-side dedupe + workdir fence remains irreducible work this change does not supply.
- ⬜ **`A3` head-of-line blocking (HIGH).** The per-thread concurrency-1 gate and slot-holding are dispatch properties, untouched. `last_progress_at` now lets a reaper *detect* a wedged run and free the gate (an improvement over today), but the gate redesign itself is out of scope.
- ⬜ **`A6` automation-vs-user starvation (MED).** Same shared gate; unchanged.
- ⬜ **`C4` non-canonical idempotency key, `D1` daemon token loop, `E1` rate limits, `E2` SSE fan-out (MED).** Orthogonal; untouched.
- ⬜ **`H1` authz asymmetry (HIGH).** Untouched — and the new `thread_message_parts`/projection read path **must re-apply the per-thread/org authorization predicate** (R23), or it silently inherits the weak org-member check and leaks at the row level. Fix `H1` itself independently (one-line ownership change, `proposals.md` Phase 0).
- ❌ **`B2` live-edge restart loss — DELIBERATE, ACCEPTED REGRESSION (MED-HIGH).** `proposals.md`'s settled edge was **file-backed R3** to survive NATS restarts. Memory-only means a NATS restart wipes all in-flight live deltas at once; they recover only when the next durable part lands. **Accepted** because the result is durable and the glitch self-heals. (Note: sharding fixes the *cross-org eviction* half — `B3` — so the regression is narrowed to *restart-loss*, not noisy-neighbor.)
- 🟡 **`I1` observability — persists and gains new failure modes (MED).** Clients now *trust* the durable parts as truth, so a silently-failed part `INSERT` is **worse** than today's best-effort save; pump failures (`B5`) masquerade as normal self-healing; the claim-check PUT adds a third silent-failure surface. **Part-append failure, pump-publish failure, client-gap-detected, and claim-check PUT failure each need a metric** (R24).
- 🟡 **Keyset/offset-drift on live threads (LOW-MED).** Keeping `LIMIT/OFFSET` (§3.6) leaves a minor correctness edge: rows appended mid-scroll can shift an offset window and *skip* a message at a boundary (duplicates are masked by client upsert-by-id, skips are not). Uncommon; resolved later by keyset if it bites.

---

## 7. Resolved decisions

The open decisions from the prior draft, now settled:

1. **Read model → fold-on-read; `thread_messages` frozen.** v2 writes **only** `thread_message_parts`; `thread_messages` is never written for v2 and becomes the frozen v1 archive (§3.6). Reads go through one `loadMessages` loader that branches v1 (query `thread_messages`) vs v2 (windowed fold of parts). **No maintained projection ⇒ no dual-write, no staleness.** An optional lazy read-cache (not `thread_messages`) is a later hardening only if fold CPU bites. *(Supersedes the earlier "eager fold maintains `thread_messages`" draft, which contradicted the frozen-`thread_messages` migration.)*
2. **Message-ordering key → `(created_at, id)`, hardened.** No new column, no `context_start_message_id`. Order on `(created_at, id)` — the `idx_thread_messages_thread_created_id` index for v1, the matching `(thread_id, created_at, id)` index on `thread_message_parts` for v2 — with `created_at` derived from the **durable part order** (monotonic per thread) instead of synthetic `now+i`. The `C5` fix; sound for both OFFSET today and keyset later.
3. **Pagination → keep `LIMIT/OFFSET`.** Adequate because each page is one-row-per-message — v1 over `thread_messages`, v2 over the per-message `finish` anchors — so offset depth is bounded by message count, and dropping the per-token firehose removed the reason keyset was needed. Keyset is a documented *future hardening* for the live-thread offset-drift edge, not a prerequisite.
4. **Live edge → memory-only retention, **sharded per-org**.** Adopt §3.2: relax retention (cost win), keep the sharded `CHAT.<shard>.<org>.>` subjects (free isolation). Closes `B3`; accepts `B2` restart-loss.
5. **Liveness cadence → a throttled `last_progress_at` bump (§3.8).** Liveness is a cheap timestamp, not a content write — fixing the progress signal without reintroducing per-token (or per-few-second) Postgres writes. The self-heal glitch bound stays "one step's worth of deltas," the user-accepted tradeoff.
6. **`H1` ownership → out of scope, but the new read path MUST re-authorize** (R23). Don't let `thread_message_parts`/projection reads inherit the weak org-member check.

---

## 8. Correctness requirements & invariants

MUST/SHOULD list the implementation has to honor.

**Read-tier & cursor**
- **R1.** Choose read tier from durable `threads.status`, never in-memory registry state.
- **R2.** Track the Postgres (durable) and NATS-live cursors independently; on reconnect, drain Postgres to the durable head **before** tailing NATS (live can never advance past a part the record lacks).
- **R3.** Completion handoff: the message's `finish` part MUST commit to Postgres **before** the NATS subject is purged and before the finish frame is emitted. On finish / any gap / closed-subject signal, the client reloads from Postgres.
- **R4.** **Liveness invariant:** a message's render converges to the durable fold once `status` is terminal **and** its `finish` part exists. Never leave a message truncated-but-finished; if terminal with no visible `finish` part, refetch until present.
- **R5.** Gaps are detected by sequence arithmetic and surfaced (backfill or render-as-in-progress) — never silently resumed at the next delta.

**Reconciliation**
- **R6.** Reconcile by `message_id`; live partial reuses the durable `message_id`; durable unconditionally replaces partial (durable wins regardless of order).
- **R7.** The partial MUST NOT be keyed by anything (transient id, `created_at`) that lets it survive as a second row; the final carries the authoritative `created_at` (so it doesn't re-sort to the end — current `mergeAndSort` sends no-`created_at` rows to `+Infinity`). On finalize, drop the live fold buffer for that `message_id`.
- **R8.** Each part is written exactly-once via `INSERT … ON CONFLICT (id) DO NOTHING`, row `id` (`<run>:<seq>`) UNIQUE + deterministic. The grouping `message_id` is separate (many parts → one message).

**Claim-check**
- **R9.** Object PUT (confirmed) **before** row commit. **R10.** Row/partition delete **before** object GC. **R11.** Orphan GC keys off object age + absence-of-row (grace window > max PUT→commit gap), never absence alone. **R12.** A reader hitting a GC'd/missing object renders a recoverable "payload unavailable" marker — never crashes the fold, never reads as truncation. **R13.** Objects live in a durable retention-managed bucket bound to row lifetime — **not** the 600 s transient TTL; preserve `<orgId>/` isolation.

**Pagination & windowing**
- **R14.** Reads paginate **one row per message**, never the whole part-stream: **v1 →** the frozen `thread_messages` (today's `listMessages`); **v2 →** the per-message `finish` anchors in `thread_message_parts` (`WHERE kind='finish' … LIMIT N OFFSET M`), then fold those messages' parts. `LIMIT/OFFSET` is acceptable; a whole-thread fold is forbidden on the hot path. The sidebar reads `threads` (`idx_threads_org_hidden_updated`), never folds messages.
- **R15.** Cross-message ordering MUST be a stable, monotonic-per-thread key (`(created_at, id)` with `created_at` from durable part order). `context_start_message_id` MUST NOT be used as a pagination cursor. Keyset pagination MAY replace OFFSET later (live-thread drift); it requires only this sound ordering key, no schema change.

**Migration**
- **R16.** Upgrade-on-touch preserves per message: the original message `id` (as `message_id`), `role`, `parts`, `created_at`/`updated_at`, relative order. Explicitly accepted loss: sub-message granularity (v1 only ever stored the final upserted message).
- **R17.** Backfill is idempotent/re-runnable (deterministic row `id` + `ON CONFLICT DO NOTHING`); the v2 flip is atomic with / strictly after backfill commit; cutover at turn boundaries only.
- **R18.** Backfill is read-only against `thread_messages`; v1 is **frozen, never deleted**; re-backfill yields identical `id`s (convergence).

**Parts, liveness & isolation**
- **R19.** Part kinds are enumerated (§3.1); token-deltas are explicitly **not** parts and never hit Postgres.
- **R20.** Liveness is a throttled `threads.last_progress_at` bump (§3.8), not a `thread_message_parts` row and not per-token; a resume MUST NOT reset liveness in a way that evades the idle deadline (`A1`/`A2`), nor treat a stalled in-flight message as alive forever (respects R4).
- **R21.** The live edge MUST keep the sharded per-org subjects `CHAT.<shard>.<org>.>`; eviction and (future) ACLs are per-shard, never global.
- **R22.** Max render-then-lose data on a gap = deltas since the last durable part (≤ one step). A run capable of a long unbroken delta stream SHOULD emit periodic parts (e.g. step-finishes); it MUST NOT run unbounded with no intervening part *and* no `last_progress_at` advance.
- **R23.** The new `thread_message_parts`/projection read path MUST apply the per-thread/per-org authorization predicate and re-authorize (no silent inheritance of the weak `validateThreadAccess` org-member check).
- **R24.** Each of part-append failure, delta-publish failure, client gap-detected, and claim-check PUT failure MUST emit a distinct metric/alert (closing the `I1` blind spot the new design otherwise *worsens*).

---

## 9. Grounding (current code, for implementers)

| Area | Where it lives today |
|---|---|
| Best-effort sampled save (`every 5th step`/final, resume=every step) | `apps/mesh/src/api/routes/decopilot/dispatch-run.ts:1048,1117,1176`; `storage/threads.ts:514` `saveMessages`; `memory.ts:97` |
| In-memory live stream (5 min, 1 replica, 500 MB, 20k/subject, fire-and-forget pump, 768 KiB split) | `apps/mesh/src/api/routes/decopilot/nats-stream-buffer.ts:34,98–204` |
| Run status (durable `threads.status`), CAS claim, deliverPolicy | `run-reactor.ts:50,89`; `storage/threads.ts:771` `claimRunStart`; `routes.ts:722` |
| Browser history (MCP list, page 5) + live SSE tail + `mergeAndSort` (upsert-by-id, no-`created_at` → `+Infinity`) | `web/components/chat/store/thread-connection.ts:368,440,574,959` |
| Object-storage offload (`messagesRef`, 768 KiB threshold, 600 s presign, `<orgId>/link-dispatch/<reqId>`, no lifecycle rule) | `harnesses/{offload-messages,remote-dispatch}.ts`; `api/.../dispatch-run.ts:974`; `object-storage/{s3-service,bound-object-storage,key-utils,factory}.ts` |
| `threads`/`thread_messages` schema; **OFFSET** reads; dormant `context_start_message_id`; pin-on-first-message precedent | `migrations/021,033,045,050,086`; `storage/types.ts:826,1017`; `storage/threads.ts:654` `listMessages`; `tools/thread/list-messages.ts`; `memory.ts:55` `loadHistory` |

---

*Generated from the design discussion + a grounding/adversarial-review pass over `proposals.md`, `report.md`, and the `apps/mesh` codebase.*
