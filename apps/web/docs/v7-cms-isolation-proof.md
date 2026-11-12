# V7 isolation evidence for the CMS refactor

This review compares the complete PR with main at
`7ecc55b39401067412474242ed478e879a6986ca`. The claim is that the new CMS
behavior is reachable only through a v8 backend. It covers v7 GitHub,
sandbox and Advanced Local tunnel storage, editor state and action payloads.
The account-less site editor is an existing explicit v8 protocol entry point.

## Repeatable comparison

Run from the repository root:

```sh
bun run check:v7-cms-isolation --base 7ecc55b39401067412474242ed478e879a6986ca
bun test apps/web/src/components/sections-editor/content-backend.test.ts
bun test apps/web/src/components/sections-editor/save-referenced-block.test.ts
bun test apps/web/src/components/sections-editor/hosted-content.test.ts
```

The comparison checks executable source against the baseline, rather than
replacing hooks, storage, authentication or HTTP with mocks. Its negative
controls deliberately change a gate and a legacy writer in memory; both must
be rejected. Compiler normalization permits formatting, comments and type-only
changes; transport import relocations use an explicit mapping. The successful
receipt contains:

- **23** explicit compiler-output comparisons of legacy implementations,
  surrounding mutation dispatch, generation predicates and dependencies.
- **25** whole changed production modules with equal compiler output after
  the listed import moves.
- **9** source invariants for legacy boundary bypasses, nested-reference gates
  and the six original legacy preparation/error boundaries.
- **2** negative controls that detect a changed HTTP method and inverted gate.

The other **57** changed or new production modules are printed separately.
They are covered by the gate/reachability review below; equality of their
whole source is not claimed.

Final validation with CI-pinned Bun 1.3.14: the checker passes, `bun run verify`
passes **13,516 tests**, and web/E2E workspace TypeScript checks pass. The
standalone comparison tool's TypeScript check also passes.

## Gate-off path

1. The unchanged project setting reader accepts only `metadata.blocksV8 === true`.
2. The unchanged connection hook reads a stored protocol connection as `null`
   when that setting is off. V7's Advanced Local tunnel remains separate.
3. The unchanged backend selector therefore returns `legacy` in both CMS and
   sandbox sessions, regardless of cached hosted or sandbox probe answers.
4. Hosted and sandbox protocol probes remain disabled. Body-loading hooks
   receive no hosted RPC, report immediate readiness and issue no CMS request.
5. Legacy reads and mutations reach the baseline implementations. The new
   pending/unavailable rejection and hosted conflict logic cannot execute.

The composed pure gate regression checks nine non-opt-in metadata values,
two runtimes, four hosted answers and five sandbox answers: **360 legacy
states**. Each also checks disabled probes with either working-tree readiness
and the existing editor choice for all three organization flag states. A
positive control verifies that strict opt-in still selects the v8 backends.

## Legacy behavior compared

| Surface | Evidence |
| --- | --- |
| Content reads | Legacy `useDecofile` query/return and the complete `useLiveMeta` function match main. |
| Save, move and delete | `writeLegacy`, `moveLegacy` and `deleteLegacy` match main. |
| Cache identity | The relocated `decofileCacheKey` retains its implementation, including the separate Advanced Local tunnel suffix. The SEO hook explicitly keeps its original v7 key. |
| Action source copies | Without a hosted RPC, the loader keeps the original shallow `isRecord && !isIndexStub` predicate; nested marker-shaped user data remains accepted. |
| Referenced saves | Legacy dispatch uses its original mutation observer and sends only `blockKey` and `data`; it receives no new explicit base or create intent. |
| Hosted conflict helpers | Changes in `draft-version`, `held-copy`, `form-base` and `hosted-reconcile` are consumed by hosted/protocol saves. The compared legacy mutation paths do not invoke them. |
| Page JSON | The dedicated legacy component retains main's implementation; the backend selector chooses it for v7. |
| Editor lifetime | New scope keys choose the old key or no key for legacy. `HeldBlockView` returns the original keyed fragment. `CmsBlockBoundary` returns legacy children before loading/error UI or a keyed wrapper. |
| Nested references | The connected adapters choose the loading wrapper only for nonlegacy backends. Marker-shaped v7 data cannot toggle that wrapper. Disconnected fields keep their original renderer. |
| Schema-free editor | Legacy keeps the original selection/reconciliation callback timing. The delayed mount-time snapshot is an explicit v8 option. |
| Content actions | Legacy retains cached reads, implicit bases, original redirect confirmation resolution, category cascades and the original preparation/error boundary. |
| Releases, tokens, draft lists and hosted publication | Existing v8 caller gates remain authoritative; legacy publication retains its original path. |
| Assets and endpoint discovery | Protocol uploads return no destination for legacy. Existing Studio uploads remain in use. Protocol discovery belongs to the standalone v8 editor. |

Independent reviews traced the entire PR's shared UI and storage changes,
including reachable callers of relocated modules. The stricter review also
identified and removed broader catches around legacy action preparation,
marker-dependent component ancestry in legacy fields and schema-free callback
timing changes outside an explicit v8 opt-in.

## Limits

Source equivalence establishes that the compared legacy implementations have
not changed. Pure tests establish the checked gate decisions and payloads.
The remaining UI gate relationships are supported by explicit source checks
and independent review. Shared imports, component adapters and disabled query
observers still change the bundle; this is not byte identity of the whole app
or a proof about every browser/runtime interaction.

Full-stack browser E2E could not run locally. The hosted Settings regressions
execute in CI with real services; their latest result is recorded in the PR
checks. Browser flow evidence remains distinct from this source comparison.
The refactor changes no production API server, storefront runtime, database
schema or dependencies.
