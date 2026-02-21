---
phase: 16-plugin-deco-blocks
plan: "04"
subsystem: plugin
tags: [typescript, bindings, scanner, testing, deco-blocks]

# Dependency graph
requires:
  - phase: 16-01
    provides: DECO_BLOCKS_BINDING in @decocms/bindings
  - phase: 16-03
    provides: scanner.ts and schema-extractor.ts implementing block/loader discovery

provides:
  - isDecoSite() helper using connectionImplementsBinding
  - Complete public API surface via index.ts
  - Unit tests for scanner, loaders, and isDecoSite (18 tests passing)
  - Bug fix: extractReturnTypeSchema handles array return types (e.g. Product[])

affects: [17-site-editor, phase-17, consumers of @decocms/mesh-plugin-deco-blocks]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Array return types handled by stripping [] suffix, generating element schema, wrapping in array schema"
    - "ts-json-schema-generator wraps schemas in definitions/$ref — test assertions must look in definitions[TypeName]"

key-files:
  created:
    - packages/mesh-plugin-deco-blocks/src/is-deco-site.ts
    - packages/mesh-plugin-deco-blocks/src/scanner.test.ts
  modified:
    - packages/mesh-plugin-deco-blocks/src/index.ts
    - packages/mesh-plugin-deco-blocks/src/schema-extractor.ts

key-decisions:
  - "index.ts re-exports DECO_BLOCKS_BINDING for consumers who don't want to import @decocms/bindings directly"
  - "extractReturnTypeSchema handles T[] return types by stripping suffix, generating element schema, wrapping in {type: array, items: ...}"

patterns-established:
  - "isDecoSite uses connectionImplementsBinding — no custom tool-name checking"

requirements-completed: [BLK-04]

# Metrics
duration: 4min
completed: 2026-02-21
---

# Phase 16 Plan 04: Wire Package — isDecoSite, index.ts, and Scanner Tests Summary

**isDecoSite() binding checker, complete public API index.ts, and 18 passing unit tests with in-memory fixture files**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-02-21T13:55:58Z
- **Completed:** 2026-02-21T13:59:46Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Implemented `isDecoSite()` using `connectionImplementsBinding(connection, DECO_BLOCKS_BINDING)` — one-liner binding checker
- Updated `index.ts` to be the clean public API: exports `scanBlocks`, `scanLoaders`, `isDecoSite`, `DECO_BLOCKS_BINDING`, `DecoBlocksBinding`, `BlockDefinition`, `LoaderDefinition`
- Wrote 18 unit tests covering `scanBlocks`, `scanLoaders`, and `isDecoSite` using temp-directory fixture files
- Fixed `extractReturnTypeSchema` to handle array return types (`Product[]`) which ts-json-schema-generator cannot resolve directly

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement isDecoSite() and index.ts public API** - `2502440e0` (feat)
2. **Task 2: Write scanner unit tests with in-memory fixtures** - `f1d54411a` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `packages/mesh-plugin-deco-blocks/src/is-deco-site.ts` - isDecoSite() using connectionImplementsBinding
- `packages/mesh-plugin-deco-blocks/src/index.ts` - Complete public API surface
- `packages/mesh-plugin-deco-blocks/src/scanner.test.ts` - 18 unit tests for scanner and isDecoSite
- `packages/mesh-plugin-deco-blocks/src/schema-extractor.ts` - Bug fix for array return types

## Decisions Made

- `index.ts` re-exports `DECO_BLOCKS_BINDING` directly so Phase 17 consumers don't need to import `@decocms/bindings` separately
- Schema test assertions navigate `definitions[TypeName].properties` since ts-json-schema-generator wraps all schemas in a `definitions + $ref` envelope

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed array return type schema generation in extractReturnTypeSchema**
- **Found during:** Task 2 (scanner unit tests)
- **Issue:** `extractReturnTypeSchema` passed `"Product[]"` to ts-json-schema-generator which throws `No root type "Product[]" found` — the library doesn't support array type expressions as root names
- **Fix:** Added array detection (`/^(.+)\[\]$/`): strips `[]`, generates schema for element type, wraps in `{ type: "array", items: { $ref: ... }, definitions: ... }`
- **Files modified:** `packages/mesh-plugin-deco-blocks/src/schema-extractor.ts`
- **Verification:** All 18 tests pass including `products loader returnType is an array schema`
- **Committed in:** `f1d54411a` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug)
**Impact on plan:** Fix necessary for loaders with array return types (the dominant real-world pattern). No scope creep.

## Issues Encountered

- `node:os` does not export `join` — test import corrected to use `path.join` from `node:path`
- TypeScript complained about `l.kind === "section"` inside `scanLoaders` results (correctly typed as `LoaderDefinition[]`) — test rewritten to cast kind as string for the check

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `@decocms/mesh-plugin-deco-blocks` is fully implemented and tested: scanner, schema extractor, isDecoSite, public API
- Phase 17 (site-editor) can import `scanBlocks`, `scanLoaders`, `isDecoSite`, and `DECO_BLOCKS_BINDING` directly from `@decocms/mesh-plugin-deco-blocks`
- No blockers

---
*Phase: 16-plugin-deco-blocks*
*Completed: 2026-02-21*
