# V8 CMS storage review

## Reported failure

`A hosted save can't write a block that isn't loaded (CMS)` is a client-side
write guard, before `blocks.apply`. Hosted reads deliberately load the index
first. `useDecofile` exposes unloaded entries as listing placeholders carrying
`__indexStub`, type, path and references. Those entries contain no settings,
sections or other body fields. They must never seed an editable form or be
spread into a replacement block.

Settings previously passed its listing entry to `readCmsSettingsBlock`, which
recognized the placeholder's `cms-settings` type as a saved block. The form
showed defaults for missing fields. `applyCmsSettingsEdits` spread that entry
into a replacement `CMS` block and the write guard rejected it. Removing the
marker or the write guard would risk replacing the entire saved settings block
with defaults and the one edited field.

The related fix in #8428 loads source bodies before page template creation,
duplication and rename. It addressed those callers, not every editor entry point.

## Storage ownership

`apps/web/src/cms` owns v8 storage communication:

| Module | Responsibility |
| --- | --- |
| `cms-api.ts` | Hosted REST requests, response errors, draft creation, endpoint construction, block hashing |
| `use-content-backend.ts` | V8 gate, hosted/local/sandbox probes, protocol client construction, availability |
| `hosted-content.ts` | Hosted RPC batching, index/listing, selective body loading, cache adoption, retry |
| `content-protocol-api.ts` | Polling, schema reads, guarded block writes, partial-write recovery, revisions, conflict rereads |
| `content-changes.ts` | Changes list, before/after bodies, discard |
| `use-asset-upload.ts` | Local protocol asset uploads; hosted/sandbox assets continue using Studio's general file service |
| `block-body.ts` | Distinguish complete bodies from placeholders, including placeholders copied into nested values |
| `block-load.ts` | Validate complete block responses and plan adoption against the original read snapshot and current versions |
| `hosted-change-base.ts` | Preserve production baselines for lazily loaded changes and deletions |
| `request-deadline.ts` | Preserve caller cancellation and bound stalled requests so shared loads can recover |
| `cache-key.ts` | Backend-specific cache scope |
| `use-blocks.ts`, `block-boundary.tsx` | Load required hosted bodies and defer mounting editors until ready, with failure/retry UI |

The existing `useDecofile`, `useLiveMeta`, `useSaveBlock`, `useMoveBlocks` and
`useDeleteBlock` hooks remain adapters shared with v7. Their protocol branches
call this module. Legacy decofile, sandbox file writes, site actions and the
v7 Local tunnel remain in their existing paths.

The existing project Settings switch remains authoritative:
`useBlocksV8Project` → `useContentBackend` → protocol backend. Body reads do
nothing for legacy/local/sandbox backends, which already read whole bodies.
Pending or unavailable backends cannot fall through save/move/delete to a
legacy writer. The account-less local site editor retains its explicit protocol
connection.

## V8 rollout boundary

For project-backed editors, the existing Blocks v8 project setting remains the
only generation gate. With it off, `useContentBackend` selects `legacy` and the
new CMS probes and hosted body requests stay disabled. The account-less
`/site-editor` keeps its existing explicit v8 protocol connection.

An additional scope audit found shared editor improvements that initially also
ran on v7. Those behavior changes are now gated: v7 uses the original Page JSON
renderer and editor keys, original referenced-save mutation observer and payload,
implicit cached save bases, redirect rule resolution at confirmation, and original
SEO cache key. V8 retains the new body-loading, source guards, scoped lifetimes
and JSON buffer protection. Regression coverage checks the legacy referenced-save
payload and its original shallow block-copy validation.

The follow-up [v7 isolation evidence](v7-cms-isolation-proof.md) records the
baseline, a repeatable compiler-output comparison, mutation controls, the full
gate trace and the remaining browser validation limit. A stricter edge-case
audit also preserves legacy action error boundaries, nested-reference ancestry
and schema-free callback timing.

Shared files and import paths still change, so this is not a claim of zero
regression risk. The PR does not change the API server, storefront runtime,
database schema, or dependencies. Browser verification runs in CI; no local
full-stack browser execution is claimed.

## Communication bypass inventory

The review searched the web source for `/api/cms/`, CMS URL/JSON helpers,
protocol client construction, `cms.index`, `cms.blocks`, `blocksApply`,
`blocksList`, changes methods, and file/asset writes.

| Former owner | Finding and disposition |
| --- | --- |
| `components/sections-editor/cms-api.ts` | Existing partial REST client; moved into the module and expanded with `cmsRequest` |
| `components/sections-editor/hosted-content.ts` | Separate RPC and body cache implementation; moved into the module |
| `components/sections-editor/content-protocol-api.ts` | Polling and block transport outside the CMS owner; moved into the module |
| `components/sections-editor/content-changes.ts` | Direct changes list/get/discard; moved into the module |
| `components/sections-editor/use-content-backend.ts` | Created protocol clients and probed endpoints; moved into the module |
| `components/thread/repository/cms-store-drafts.ts` | Direct draft list/delete fetches; now uses `cmsRequest` |
| `components/thread/repository/hosted-publish-api.ts` | Direct publish fetch; now uses `cmsRequest`, preserving publish error mapping |
| `layouts/main-panel-tabs/releases-api.ts` | Direct releases pagination and rollback fetches; now uses `cmsRequest` |
| `views/virtual-mcp/settings/site-token-section.tsx` | Direct token list/issue fetches and separate JSON error parser; now uses `cmsRequest` |
| `hooks/use-deco-serve-discovery.ts` | Constructed and fetched a protocol client; now calls the module's `probeEndpoint` |
| `components/sections-editor/fields/use-serve-asset-upload.ts` | Direct local protocol asset upload; moved into the module |

General Studio uploads, preview iframe URLs, monitoring traffic, registry/tool
calls, v7 decofile calls and sandbox source-code edits are not hosted CMS block
storage. Their existing service clients remain appropriate.

## Editable-body inventory

The review followed every `useDecofile` consumer and every save, move and delete
hook consumer, including editors receiving content through props.

| Surface / operation | Result |
| --- | --- |
| Settings, standalone and generic form | Fixed: `CmsSettingsEditor` waits for `CMS` before reading its type/values or creating form guards. A name absent from the loaded index still shows defaults and is created on first edit. |
| App settings, site settings, redirects, blog post/category/record editors, global loader editor | Shared `HeldBlockView` now waits for its block before mounting the form. Existing reconciliation/remount behavior remains. |
| Content body-backed lists | Fixed: body loads were started but their result was ignored. Their names now participate in the editor's awaited load along with its selected block and references. |
| Blog Context / brand / formats | Fixed: explicitly loads the three fixed-name blocks before showing the workspace. |
| Schema-free fields and JSON | Fixed: the connected adapter wraps the selected editor in the loading boundary. The form takes its held copy when its complete body mounts, including an initially selected block. The pure presentation component remains usable without a storage provider. |
| Preview Page JSON side panel | Fixed: explicitly loads its page and makes the editor unavailable during load/failure; retry is available. |
| Content Page JSON dialog | Fixed: its caller loads the page before mounting the dialog and save hook. |
| Page templates, duplicate and rename | Retains #8428's `useLoadDecofileBlock` → `loadBlockBody`. Also fixed section duplicate/rename, page variant creation, blog duplicate/reschedule: their action handlers now explicitly load sources inside their error boundary, even when invoked before opening an editor. |
| Sections editor and saved section selection | Existing selected page/block and direct-reference loads remain; selected-body load gates the editor. |
| SEO editor / sheets | Existing site SEO body loading remains. Fixed the save hook's hard-coded cache key to use the backend-specific scope, preventing local/sandbox edits from reading another cache. |
| Experiments / Calendar views | Existing `SiteDraftView` waits for experiments/campaigns bodies. Named-rule edits also explicitly ensure their bodies before writing. |
| Preview-as picker | Existing lazy load of experiments/campaigns remains. Preview links themselves are navigation, not writes. |
| Page/section creation and referenced block saves | Newly constructed bodies use shared save hooks and the guarded protocol writer. Fixed nested saved-block fields (`AnyOfField`) and saved matcher rules (`VariantRuleEditor`): picking an unloaded reference loads its body before mounting the nested form, including references beyond the parent's initially loaded direct references. |
| Redirect append/remove and category deletion cascades | Fixed action-time reads: append/remove loads the redirects holder, and category deletion loads the category and the body-backed collection before constructing post updates. This also protects helpers that reconstruct objects and would otherwise silently lose fields without carrying the placeholder marker. |
| Blog generation, scheduling, status moves, campaign moves, category rename/cascades | Shared save/move/delete adapters use the central writer; body-backed collections load before the workspace opens. |
| App installation | Protocol projects do not install through the legacy file writer; the existing guard remains. |
| Publish, discard and release rollback | Central REST/changes transport; existing content synchronization refreshes editor, revision/pointer and status. |

## Guardrails

- The write guard remains mandatory. It now rejects a placeholder nested inside
  another block too, not only one at the block root.
- A placeholder in the body cache cannot satisfy body readiness or skip a body
  load merely because it has a matching version. A hosted loading boundary
  waits for the index before deciding whether a requested name is absent.
- Loads coalesce within each `QueryClient`; different cache clients cannot
  accidentally join a load that writes only to someone else's cache.
- `ban-cms-storage-bypass` rejects protocol client construction, direct block
  and changes calls, hosted URLs, or transport-only CMS helpers outside the
  module. Its smoke and regression fixtures exercise real oxlint.
- `ban-cms-git-imports` covers the new CMS directory. Shared v8 detection checks
  follow the moved backend selector and continue forbidding schema heuristics.

These controls prevent the identified paths from submitting incomplete bodies.
The final write guard intentionally still rejects invalid payloads; arbitrary
future callers cannot be guaranteed safe solely by moving files. Use the body
boundary for new forms and the explicit loader for new copy operations.

## Verification

Pure regression tests reproduce the Settings placeholder spread and verify
that editing a loaded body preserves unrelated settings. They cover nested and
copied placeholders, empty bodies, invalid values and absence. Existing editor,
protocol, conflict, hosted load, gating and source-boundary suites are retained.

`packages/e2e/tests/cms-hosted-settings.spec.ts` adds two browser regressions
against real Studio HTTP routes and the suite's delivery infrastructure: cold
Settings with a saved body, and first-save creation without a saved body. They
assert the persisted complete body and reload behavior. Run these with the
normal Playwright services; unit tests cannot establish browser wiring.

Final local results:

- `bun run verify`: formatting, lint, unused-code checks and **13,516 tests passed**
  using the repository's CI-pinned Bun 1.3.14.
- Web and Playwright workspace TypeScript checks passed.
- Playwright discovered both new hosted Settings regressions.
- Browser execution was unavailable locally: PostgreSQL/NATS were unavailable,
  their environment URLs were unset, and Docker was not installed. CI runs the
  browser assertions with the normal E2E services; consult the PR checks for
  the latest outcome.

The first CI execution found a navigation-selector defect in both new Settings
regressions: the draft-change badge contributes to the button's accessible name,
so an exact `Settings` match fails once the block is changed. The tests now use
the existing Settings sidebar wrapper and its button. Their body-load,
preservation, creation and reload assertions remain intact. CI also reproduced
an OAuth integration timeout already failing on main: that test's authorization
metadata case now has time for both bounded discovery stages to finish. These
CI repairs change tests only, with no production behavior change.

Local Bun 1.4.0 full-suite attempts encountered `EBADF` while spawning oxlint
subprocesses; the isolated plugin smoke test passed. The final complete run
used CI's Bun version through a temporary PATH, with the verification command
and all tests unchanged. No global runtime setting or test exclusion changed.

## Adversarial review

Four independent reviews covered storage concurrency, UI integration and code
quality, including a final independent quality pass. Confirmed findings were fixed and rechecked; the review does not claim
that arbitrary future changes or unavailable browser verification can be proven
bug-free.

| Finding | Correction |
| --- | --- |
| A late body response could overwrite a newer save, optimistic edit or deletion. | Body adoption compares the original operation snapshot, current cache slot and current indexed version. The same snapshot spans all batches, including loads over 500 names. |
| A stale complete listing could be used as a copy source. | Hosted action reads use the current body cache; action writes explicitly carry the source copy as their base. |
| Cache notification could precede delivery of new listing props. | Initial editor readiness requires the same complete body in the cache and the parent's listing; absent entries must agree with parent absence too. |
| Refreshes could unmount forms and drop pending text. | Open boundaries retain their forms through background refresh; the JSON panel retains its raw buffer, including invalid JSON. |
| A cached draft switch could reuse another draft's form, confirmation dialog or debounce state. | Editor and dialog lifetimes are keyed by organization, project, branch and storage destination. Temporary availability is separate from destination identity. |
| Pending/unavailable storage could report body readiness. | Availability gates fail closed before initial form mounting; retries target the current backend. |
| Indexed redirect deletion could remove the wrong rule after reordering. | Confirmation retains the original holder body and rule index; the write is guarded by that body. |
| Newly created names could overwrite an already-existing draft block. | Creation and duplication use explicit create-only intent and existing conflict reconciliation. |
| Referenced forms could capture a newer base than the copy they edited. | The shared referenced-block saver requires the displayed snapshot; nested blog references use their own ordinary save hook rather than the root form's held copy. |
| Tombstones or an emptied draft could bless an older complete copy. | Full source copies retain their own hash when deleted, discarded, or different from known current production. |
| Deleting an unopened published block could disappear from Review. | Deletion adoption takes its production baseline from the index when its body has not loaded. |
| Late changes replies could hide locally adopted saves. | Changes adoption preserves a newer cache entry, even when the server revision string is unchanged. |
| Review could reuse cached before/after bodies after a local save. | Side-cache identity includes the production base and sorted changed block versions, not only the list revision. |
| Two cache clients could join a poll that writes only into one cache. | Poll and external-write reread coordination is scoped to each QueryClient, with identity-safe cleanup. |
| Namespace imports, method extraction and generic batches could bypass lint enforcement. | The storage boundary rule covers those forms, dynamic imports and re-exports while permitting unrelated batch clients and public helpers. |
| Invalid success JSON could be acknowledged as an up-to-date publish. | Successful JSON parsing fails explicitly; publish and rollback validate their result/revision contract before acknowledgment. |

The new regression tests exercise pure cache transitions, stale source guards,
production/deletion baselines, backend identities, response parsers, change-side
cache keys and real lint diagnostics. Existing editor/protocol suites continue
to cover the surrounding behavior. The two browser regressions execute against
the normal E2E services in CI.

The final independent quality pass also caught an A → loading B → A readiness
latch reuse and unbounded shared requests. The latch now resets on every target
transition, while a same-destination background refresh preserves the open form.
CMS requests retain caller cancellation and have a 60-second deadline so a
stalled read releases its coalesced promise and can retry. The deadline does
not add automatic retries to publish, rollback or other side effects.
