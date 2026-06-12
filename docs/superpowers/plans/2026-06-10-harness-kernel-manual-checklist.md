# Harness Kernel Convergence — Manual Release Gate

Companion to `2026-06-10-harness-kernel-convergence.md` (Tasks 1–21) and
`../specs/2026-06-10-harness-kernel-convergence-design.md`.

CI verifies the shared kernel through the relay driver
(`apps/mesh/e2e/tests/harness-conformance.spec.ts`) plus the per-task unit
suites. It **cannot** cover what follows — there is no real `decocms link`
daemon, no real CLI binaries (claude-code / codex), no hard-break protocol
fixture against a stale daemon, and no canary in CI. A human must walk these
before shipping, and the BLOCKER at the bottom must be cleared before raising
the v2 / pull-only canary for real users.

How to bring up a real local desktop link:

```bash
# Cluster + embedded services, desktop sandbox provider on:
bun run dev --local-sandbox-provider
# In a second terminal, link a real daemon (latest published CLI):
bunx decocms@latest link
```

Watch the `decocms link` terminal — it surfaces the daemon-side log lines
(WS handshake, resume=yes/no, rebased cwd, protocol gate) the cluster never
prints.

---

## 1. Desktop — real `decocms link` daemon

A linked desktop daemon, pull transport only (push `remoteDispatch` is deleted).

- [ ] **Live Decopilot turn.** Open a desktop Decopilot agent, send a turn.
      Text streams live into the UI (not one delayed blob). Parts persist
      (reload the thread — the assistant message is still there). Auto-title
      appears exactly **once** on a fresh (default-titled) thread and does NOT
      flip on later turns. The final assistant message carries non-zero usage.
- [ ] **Self-subtask.** Ask the agent to spawn a subtask against itself. The
      subtask completes and its tokens are rolled into the **parent's** final
      usage total (parent total = parent tokens + subtask tokens).
- [ ] **Cross-agent subtask.** From one active org agent, spawn a subtask
      targeting a DIFFERENT active org agent (by its agent id). It completes.
      Then target a **non-existent** agent id → a clear tool error surfaces in
      the thread (not a hang, not a silent no-op).
- [ ] **Cancel mid-run.** Start a long turn (and a subtask), cancel from the UI
      mid-stream. The daemon-side harness loop aborts AND the in-flight subtask
      aborts (signal chaining). The run lands in a terminal cancelled/failed
      state — no zombie that keeps streaming.
- [ ] **Network blip + reconnect.** Mid-run, kill the daemon's network
      (e.g. toggle wifi / block the WS) and restore within ~30s. The chunk
      relay reconnects, the thread completes, and there are **no duplicate
      parts** (seq dedupe + fence-epoch validation hold). Reload to confirm a
      single clean message.

---

## 2. CLI harnesses — real binaries (claude-code / codex)

Needs a repo-backed agent (a checkout under the sandbox) and real model keys.

- [ ] **claude-code file edit lands in the checkout.** Run a claude-code turn
      that edits a file. The edit lands under the repo checkout
      (`<sandbox>/repo/...`), NOT at the sandbox app root. (Symbolic
      `workspace.cwd` → daemon rebase with containment.)
- [ ] **claude-code resume.** Send a SECOND turn on the same thread. The
      `decocms link` daemon log shows `resume=yes` (the finish-anchor
      `codingAgentSessionId` was persisted on turn 1 and read back on turn 2).
- [ ] **codex turn + usage.** Run a codex turn to completion; the final message
      carries usage.
- [ ] **Title e2e specs, locally.** Run the specs that CI skips for want of
      keys, with real keys exported:
      ```bash
      E2E_ANTHROPIC_KEY=... bun run --cwd=apps/mesh e2e -- claude-code-title
      E2E_OPENAI_KEY=...    bun run --cwd=apps/mesh e2e -- codex-title
      ```
      Both go green (auto-title flows through the CLI harness title side-channel).

---

## 3. Hard break — stale daemon vs new cluster

Protocol v2 is a hard break (link version bump + 426 gate). Verify it fails
LOUDLY, never silently.

- [ ] **Old daemon, new cluster.** Point an OLD (pre-v2) `decocms link` daemon
      at the new cluster. The link is rejected with **426 / `protocol_mismatch`**
      and the terminal shows a clear "re-run `bunx decocms@latest link`"
      instruction. It does NOT half-connect or silently drop turns.
- [ ] **In-flight old-shape work item.** If an old-shape work item is already
      enqueued when the cluster upgrades, the run fails **cleanly** (schema
      rejection / clear error), not a partial corrupt persist.

---

## 4. Cluster — hosted path unchanged

The hosted (agent-sandbox / legacy) path must be untouched by the convergence.

- [ ] **Hosted Decopilot turn.** A hosted Decopilot turn behaves exactly as
      before this branch: live streaming, auto-title once, usage on the final
      message, correct run status transitions, PostHog `chat_message_completed`
      fires.
- [ ] **PostHog parity, both transports.** Confirm `chat_message_completed`
      fires with **non-zero tokens** for BOTH (a) a hosted run and (b) a desktop
      **pull-relay** run — the relay path feeds the same kernel onUsage hook, so
      the event must look identical modulo transport.

---

## ⚠️ BLOCKER — before enabling the v2 canary / pull-only desktop for real users

There is a **pre-existing** bug (NOT introduced by this branch; root cause
landed in PR #3698, `d54b94ca9`, an ancestor of `main`) that this branch makes
load-bearing because pull (which requires the v2 storage generation) becomes the
sole desktop transport.

**Symptom:** multi-turn v2 threads silently drop every turn after the first.
`thread_message_parts` uses a primary key of `${runId}:${seq}` where
`runId == threadId` (reused on every turn) and `seq` restarts at 0 each turn, so
turn 2's rows collide with turn 1's and are swallowed by `ON CONFLICT DO
NOTHING`. Dormant today only because `STREAM_OF_RECORD_V2_PERCENT=0`.

- [ ] **Do NOT raise `STREAM_OF_RECORD_V2_PERCENT` (or enable pull-only desktop
      for real users) until a multi-turn v2 thread is verified to persist ALL
      turns.** Fix direction: give the part-id namespace a per-turn-unique but
      resume-stable component — a run-instance id assigned at RunRegistry START,
      preserved across RESUME, threaded into the `PartEmitter` and the pull work
      item. The read path needs no change (it folds by `thread_id` / `message_id`).

Full analysis + repro live in the team notes referenced by the PR body.
