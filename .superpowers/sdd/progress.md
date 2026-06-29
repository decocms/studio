# SDD Progress: decopilot message-id unification

Plan: docs/superpowers/plans/2026-06-29-decopilot-message-id-unification.md
Branch: eta-telescopii
Start BASE: (the spec+plan commit — recorded in Log below)

(Replaces the prior ledger for 2026-06-26-decopilot-projection-single-workflow — all 12 of its tasks complete and committed; its WIP tail is folded into this plan's baseline checkpoint.)

## Goal
One id authority = the harness-stamped `start.messageId`, consumed verbatim by client + JetStream + DB, so approval/tool-output continuations merge onto the proposal message instead of duplicating it.

## Tasks
- [ ] Task 1: share one message-id generator; stamp start.messageId in all 3 harnesses (decopilot, codex, claude-code)
- [ ] Task 2: consumeHarnessStream — adopt harness id + continuation merge from originalMessages
- [ ] Task 3: terminal projector — drop the remap, delete projectionMessageIdGenerator + continuationAssistantMessageId
- [ ] Task 4: checkpoint + live ingest — thread originalMessages into checkpoint fold, delete assistantMessageIdGenerator
- [ ] Task 5: e2e — approval continuation persists exactly one assistant message

## Log
(start) Baseline: mesh `tsc --noEmit` green before checkpoint.
