---
title: Decopilot Context Compactification — Research & Parked Design
status: parked
parked_reason: Depends on DBOS-based async work primitives landing via PR #3337
date: 2026-05-12
owner: tlgimenes
---

# Decopilot Context Compactification — Research & Parked Design

## Status

**Parked.** Resume after PR [decocms/studio#3337](https://github.com/decocms/studio/pull/3337) (`refactor(automations): use DBOS for scheduling and firing`) merges. That PR replaces the in-process cron worker, JetStream job queue, and semaphore with DBOS workflows. The Observer in this design is an async worker — riding DBOS rather than building parallel async infra is the right path.

Split-out: the **task-list / TodoWrite-style feature** is being designed and shipped independently of this. See sibling spec.

## Goals (ranked)

- **A.** Threads never hit the model context ceiling. Hard requirement.
- **D.** Multi-day thread continuity. A user returning on day 14 finds the agent coherent.
- (Secondary) Token cost, lost-in-the-middle quality.

## Current state of decopilot (2026-05-12)

- Memory loads the **last 50 messages** per turn (`apps/mesh/src/api/routes/decopilot/memory.ts`, `DEFAULT_WINDOW_SIZE`).
- Prompt assembly: system prompts + threadMessages + requestMessage → AI SDK `convertToModelMessages` → `streamText` (`apps/mesh/src/api/routes/decopilot/stream-core.ts`).
- **No summarization, rollup, or token-aware truncation exists.** A long thread will eventually break.
- Docs (`apps/docs/.../decopilot/context.mdx`) sketch a 6-slot context layout and a 40/80 rule, marked as intended-not-implemented.

## Options surveyed

Full research briefing in conversation transcript. Summary:

| # | Name | Trigger | Authorship | Mutability | Cache-friendly | Provider-portable | UI-inspectable |
|---|------|---------|-----------|-----------|---------------|------------------|----------------|
| 1 | Rolling Digest + Recent Window | threshold | system | rewritten | ❌ | ✅ | prose |
| 2 | Tiered Agentic Memory (MemGPT/Letta-style) | agent decides | agent via MCP tools | append + edit | ⚠️ | ❌ varies by model | structured |
| 3 | Typed ProjectState + Event Log | threshold | extractor side-call | patched | ⚠️ | ✅ | structured |
| 4 | Asynchronous Observational Log (Mastra-style) | threshold | async observer | append-only + reflections | ✅✅ | ✅ | prose |

Lineage references: Claude Code `/compact`, Aider repo-map, SWE-agent observation elision, Anthropic memory tool + context editing, Letta/MemGPT (Packer 2023), CoALA (Sumers 2024), Reflexion (Shinn 2023), Mastra Observational Memory (2025), "Lost in the middle" (Liu 2024), recursive summarization (Wu 2021).

## Selected design: hybrid 4 + 3

Per-thread durable artifacts:

1. **Observational log** — append-only markdown observations written by an **async Observer** (cheap model, e.g. Gemini Flash or Haiku). Triggered when unobserved-tokens > 30k. Sync fallback at 1.2× threshold to prevent overflow. When the log itself grows past ~40k tokens, a **reflection pass** compacts older observations into denser ones (two-level hierarchy).
2. **Typed `ProjectState` sidecar** — small Zod-schemaed snapshot extracted from observations during reflection. Approximate shape:
   ```ts
   {
     goals: string[];
     open_questions: string[];
     files: Record<string, { summary: string; last_seen_hash: string }>;
     blockers: string[];
   }
   ```
   `ProjectState` is queryable and human-inspectable in the UI. It is *derived* from observations, not authored independently — single source of truth.
3. **Task list** — **decoupled from this design**, model-managed via tools (`TASK_CREATE` / `TASK_UPDATE`), per-thread, ephemeral, chat-UI-rendered. Being designed as its own feature.

### Per-turn prompt assembly

Ordered stable → mutable for prompt-cache reuse:

```
1. system prompts          (cached)
2. ProjectState            (cached until next reflection)
3. Observations + reflections  (cached, append-only)
4. Open task list          (small mutable)
5. Last K raw turns        (K ≈ 10–20; was 50)
6. New user message
```

Anthropic prompt caching benefits 1–3 directly. Stages 4–6 are small.

### Why hybrid over pure 4

- Pure observational log is prose. Goal D ("user returns on day 14") is partly a **UX** problem — the user wants to *see* what the agent remembers. A typed `ProjectState` panel makes that legible.
- Multi-provider via AI SDK means a typed sidecar survives model swaps mid-thread; a prose summary's style does not.
- Extracting `ProjectState` only during reflection (not every observation) keeps the extractor cost amortized.

### Why async observer matters

- No latency tax on user turns. Compaction is invisible.
- Burst handling via sync fallback at 1.2× threshold preserves goal A.
- Decopilot's existing event bus + NATS notify could carry this — **but** the DBOS migration in PR 3337 changes the async substrate. Building on the post-PR primitives avoids rework.

## Replaced/changed surface

- `apps/mesh/src/api/routes/decopilot/memory.ts` — `loadHistory(50)` → `loadRecentMessages(K)` + new `loadObservations(threadId)` + `loadProjectState(threadId)`.
- `apps/mesh/src/api/routes/decopilot/stream-core.ts` — prompt assembly updated; emit "message-saved" events for the Observer.
- New migrations:
  - `thread_observations(id, thread_id, kind 'observation'|'reflection', content, tokens_covered, created_at)`
  - `thread_project_state(thread_id PK, state_jsonb, updated_at)`
- New DBOS workflow: `observation-worker` subscribed to message-saved events, debounced per thread, threshold-gated.
- New cheap-model provider configuration: which model the Observer uses (default Gemini 2.5 Flash, configurable per org).

## Open questions to resolve on resume

- Exact thresholds (30k / 40k are Mastra defaults — validate against decopilot's typical thread shape).
- Tool-call output handling: SWE-agent-style elision of stale `tool_result` blocks (replace with `<elided n_tokens=...>` placeholders + path-keyed cache for file reads). How aggressive?
- Cross-thread memory: out of scope here, but worth a brief note on whether `ProjectState` should escape thread boundary later (e.g. per-project facts).
- Cost ceiling for the Observer (per-org rate limit?).
- Failure modes: Observer crashes → fall back to raw window + hard ceiling guard.

## Out of scope for this design

- Cross-thread / cross-project semantic memory (CoALA semantic tier).
- Vector retrieval over archived turns (could be a later phase).
- User-editable observations or `ProjectState` (Observer is authoritative).
- The task-list / TodoWrite feature (separate spec).

## Resume checklist

When PR 3337 lands:

1. Read the merged DBOS workflow API and update the Observer worker design.
2. Validate thresholds against real thread data (`SELECT thread_id, SUM(tokens) FROM thread_messages GROUP BY thread_id`).
3. Spec the cheap-model provider plumbing (org-level config, fallback chain).
4. Resume brainstorming → writing-plans flow.
