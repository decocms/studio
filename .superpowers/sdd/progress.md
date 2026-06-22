# SDD: Desktop Relay To Direct NATS - Progress Ledger

Progress tracking for the 9-task refactoring to move desktop relay chunks from HTTP-based chunk relay to direct NATS publish, eliminating the `/chunks` route.

## Tasks

| # | Task | Status |
|---|------|--------|
| 1 | Make ingestRun Projector-Only For Persistence | pending |
| 2 | Remove Hosted Inline Part Persistence | pending |
| 3 | Move Completion Analytics To Projector Workflow | pending |
| 4 | Add Direct NATS Publisher For Desktop Relay Rows | pending |
| 5 | Thread Active NATS/JetStream Into Work Dispatch | pending |
| 6 | Replace HTTP Chunk Relay With Direct NATS Relay | pending |
| 7 | Scope Daemon NATS Publish Permissions | pending |
| 8 | Remove `/chunks` Route And Tests | pending |
| 9 | End-To-End Verification And Cleanup | pending |

## Notes

- Started: 2026-06-22
- Branch: pi-sextantis
