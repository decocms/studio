# Companion Config Selectable List — Progress

BASE: 35624272969e8fb84ee2b793f3d12d7e8e6947a4

## Tasks
- [x] Task 1: SelectableList presentational component (commit 39c071d, review clean)
- [x] Task 2: GA form (commit dd5f82e, review clean)
- [x] Task 3: GSC form (commit f19bb0b, review clean)
- [x] Task 4: verification (build/lint/fmt clean, app renders no console errors; live GA/GSC dialog needs OAuth - not reachable here)

## Minor findings (for final review)

---
- Task 1 minors (non-blocking, no fix): index key for unlabeled groups; aria-checked boolean serialization; list-level disabled only.

## Final review
- Whole-branch review (opus): mergeable, 1 Important a11y finding -> fixed in f145a43 (keyboard nav + accessible name).
- Re-review (opus): clean and mergeable. Remaining Minor (dataset.value! redundancy) left as-is.

Commits: 39c071d, dd5f82e, f19bb0b, f145a43

## PR
- https://github.com/decocms/studio/pull/4265 (tau-cancri -> main, pushed via SSH)
