# CMS mode / Vibecoding mode — implementation plan

Implements [`cms-mode-spec.md`](./cms-mode-spec.md).

> **Revised after a 7-perspective critique.** The first draft was one PR built on five false premises. It is
> now five PRs built on verified ones. See [Critique decisions](#critique-decisions).

> **Rebased on `main` (`76d13142b`), after PR #6054.** All pointers below were re-verified against the
> rebased tree — every finding survived; only `preview.tsx` line numbers moved, and they are resynced.
> `previewOrigin(previewUrl)` now has **five** call sites (`:876, 915, 925, 932, 954`), not two.

**Blast radius, counted not estimated:** `fastPreview`/`fast-preview` appears **211 times across 34 files in
4 workspaces** (`apps/web`, `apps/api`, `packages/shared`, `packages/e2e`), plus ~20 more files for the panel
work. One PR is not reviewable and its rollback story does not hold once a project has written
`metadata.cmsMode`.

Line numbers drift — treat them as pointers.

---

## ~~PR 0 · Redact credentials from daemon console output~~ — cut, file separately

**Not in scope.** It was justified by PR 5's "console always available during boot". With PR 5 cut, re-keying
the console gate from `fastPreviewEnabled` to "a pod exists" is a **no-op in practice** — CMS mode implies no
pod, so exactly the same people see the console in exactly the same situations as today. This work does not
promote the leak.

**It is still a real bug and should be filed on its own:**
`clone.go:444` puts the clone URL (`https://x-access-token:ghs_…@github.com/…`) in argv, `:92` echoes argv
verbatim via `OnChunk`, and `events/broadcast.go:94` also appends it to the **replay buffer**, so it is
readable after boot by anyone with workspace access. Fix is `stripCredentials`
(`internal/setup/install.go:23`) applied in `formatArgv`, failing closed, asserted on the emitted bytes in
`packages/sandbox/daemon-e2e/` (CLAUDE.md #8). Independent of this plan in both directions.

---

## PR 1 · Rename, all four workspaces

Mechanical, boring, and reviewable *because* it is boring. **Not** "no behaviour change" — it touches an
authorization input.

- Put the dual-read in **`packages/shared`** (beside `resolvePreviewServerUrl`, whose `productionUrl` alias
  is the precedent) so web *and* api inherit it. `resolveFastPreview` → `resolveCmsMode`.
- **Consume it from all four current copies of the gate.** It is not "in ONE place" as its own doc claims:
  - `apps/web/src/sdk/fast-preview.ts` (the helper)
  - `apps/web/src/components/sandbox/preview/preview.tsx:373` — **inlines the gate**, never imports the
    helper. Fix this first or the rename skips the file PRs 3–4 edit most.
  - `apps/api/src/api/routes/decofile.ts:124`
  - `apps/api/src/api/routes/sandbox-proxy.ts:213`
- **Keep writing `fastPreview` in this PR.** Read both, write old. The write flips only once every reader
  ships. The metadata object is `.loose()`, so a premature `cmsMode` write type-checks and fails only against
  a real server.
- Add `cmsMode` to the schema (`packages/shared/src/sdk/types/virtual-mcp.ts` — 3 sites) and run
  `bun run --cwd=apps/api generate:tool-contracts`.
- i18n: rename keys **and retranslate pt-br values** — `bun run check` proves key completeness, not that
  `pt-br/sandbox.ts:542` stopped saying "Preview Rápido".
- Leave `FAST_PREVIEW_CACHE_DIR` (`apps/api/src/decofile/disk-cache.ts`) alone — it is a deploy-config env
  var. State this explicitly so it does not read as an oversight.
- **New e2e:** write `cmsMode` only, then hit the decofile route. The existing suite seeds `fastPreview`
  directly (`packages/e2e/tests/decofile-api.spec.ts:161`), so it cannot catch this class of break.

**Tests to update:** `blocks-tab-state.test.ts`, `preview-display.test.ts`, `section-preview-url.test.ts`,
`sandbox-lifecycle-context.test.ts`, `decofile-api.spec.ts` (asserts the literal 404 string at `:265`).

---

## PR 2 · Widen `SidePanelKind` — all of it

`use-layout-state.ts:24` → `"chat" | "cms"`. The type is the easy half; **six** files hardcode the literal,
and three fail silently rather than at compile time:

| File | Line | Failure |
| --- | --- | --- |
| `router.tsx` | 298 | zod `"chat" \| 0` — **`?sidepanel=cms` is rejected** |
| `lib/thread-layout-memory.ts` | 27, 43 | **silently drops** the kind from layout memory |
| `chat/hooks/use-chat-navigation.ts` | 47 | **silently closes** the panel on thread navigation |
| `layouts/resolve-task-switch-search.ts` | 60 | compile error |
| `layouts/shell-layout.tsx` | 97, 119 | compile error |
| `main-panel-tabs/mobile-main-panel-tab-select.tsx` | 142 | hardcoded |

Also mode-aware the three hardcoded `"chat"` defaults — `withWorkspaceFallback` (`:93`),
`resolveDefaultPanelState` (`:111`), and `resolveMobileSurface` (`:180`), which the first draft missed.
`MobileWorkspaceSurface = SidePanelKind | "main"` widens for free.

`withWorkspaceFallback` is **module-private and not in the test file** — test it through
`resolveDefaultPanelState` rather than exporting it (keeps knip quiet).

Parse unknown values to the union at the boundary; unit-test that `?sidepanel=junk` degrades to the default.
The rollback story assumes this and nothing currently provides it.

**Tests:** update `use-layout-state.test.ts` (all 10 cases), add round-trip cases for
`use-chat-navigation` + `thread-layout-memory` — the two silent ones.

---

## PR 3 · De-duplicate before building

No behaviour change. Each item shrinks a later PR.

1. **Delete `ContentBrowser`'s dead `mode="blocks"` path.** `content-tab.tsx:31` renders `<ContentBrowser />`
   with no `mode`, so ~10 branches (`content-browser.tsx:351, 357, 364, 378, 1032, 1050, 1117, 1340` + the
   prop at `:243-247, 298, 336`) are unreachable. **`knip` will not find this** — it reports unused exports,
   not unreachable prop branches.
2. **Extract `redirectIfInvisible()`** from `use-main-panel-tabs.ts:310-319`, where the `git` condition is
   written twice and `content` is handled in one arm but not the other. Cover `git`/`content`/`code`
   uniformly. There is **no `use-main-panel-tabs.test.ts`** — extracting is what makes this testable.
3. **Extract a shared `<BlockEditorHost>`** — the `lazy(() => import(sections-editor))` wrapper and the
   `page:${k}` / `section:${k}` key builder are written twice (`blocks-panel.tsx:26-30, 110-114` and
   `content-browser.tsx:145-149, 1315-1319`), and have already drifted:
   `onVariantPreviewOverride` is passed by only one.

---

## PR 4 · The CMS panel moves into the side panel

Gated to projects where CMS mode is available (`resolveCmsMode(metadata).active`) — **not** to every project
with content, per the spec's corrected prerequisite.

- `workspace-panel-group.tsx:324` — replace `FastPreviewChatNotice` with `BlocksPanel`.
  `BlocksPreviewWorkspaceProvider` already sits above the panel group (`agent-shell-layout/index.tsx:326`),
  so no state lifting.
- Add `CmsToggle` beside `ChatToggle`; carry `disableActiveSidePanelToggle` as `ChatToggle` does.
- **`resolveBlocksTabState` must be re-keyed too** (`blocks-tab-state.ts:44, 92`). It takes the gate as an
  explicit input and was missing from the first draft's list — without it the panel renders a permanent
  spinner.
- **Do not delete `chat.input.fastPreviewComingSoon`** — `input.tsx:644` still uses it. Delete only the
  component; the key is re-copied in PR 5.
- **Move the CMS tour anchor.** `TOUR_ANCHORS.edit` is the tour's readiness gate
  (`cms-tour.tsx:40` `READY_SELECTOR`) and lives on the button PR 5 deletes. Move it to `CmsToggle`; update
  `steps.ts` + `steps.test.ts`. `<CmsTour>` renders at `workspace-panel-group.tsx:292` — the file this PR edits.
- **Relocate `BlocksPanel`'s state components** (`MainPanelLoading`, `BlocksEmptyState`, `BlocksErrorState`)
  out of `layouts/main-panel-tabs` — side-panel content should not depend on main-panel layout modules.
- ~~Disable `onActivate` in CMS mode.~~ **Dropped — #6054 solved it.** CMS mode no longer mounts
  `HeaderActions` at all (`header-info.tsx:28-32`), so `send()` / `openSidePanel("chat")` is unreachable there.
- Tabs, console and preview origin follow **pod presence**, not the panel — so no tab-redirect logic is
  needed here, and a developer opening the CMS panel keeps Code and Review changes.
- Follow the **mount-boundary pattern** from `header-info.tsx`: branch and mount a different component,
  rather than threading a mode input into a shared one. `workspace-panel-group.tsx:324` already has the
  identical shape.
- Reuse **`isCmsStateSettling`**'s rule for the panel's save indicator. Note `use-save-block.ts` /
  `use-delete-block.ts` now **await** their status invalidation (changed in #6054, shared with vibecoding),
  so the indicator already stays lit until the re-read lands.

> The 320px floor already exists (`workspace-panel-group.tsx:297`
> `[&>[data-workspace-panel-open]]:!min-w-[320px]`). The first draft's 250px measurement tested an
> unreachable width. Drop the per-kind width storage — speculative, and it forks a localStorage key with no
> migration.

**Click-through selection is deferred to PR 5** — it depends on the origin decision, which is a security
question, not a refactor. See the spec's open question 1.

---

## PR 5 · The boot flow and the origin decision

> **Recommend cutting.** Two critics called it speculative; I kept it because it was explicitly asked for.
> #6054 has since made it *harder*, not easier, and that tips the balance.
>
> The shipped design makes CMS ⟹ no pod structural: `header-info.tsx` branches at the mount specifically so
> that lifecycle hooks never mount on a CMS surface, and `SelectCmsHeaderButtonInput` has no pod input at
> all. "CMS project that also boots a pod" now means unwinding a deliberate, tested, merged decision —
> and the CMS header would have to grow a pod concept it was just designed to be free of.
>
> The cheaper path to the same user need is the **handoff**: a CMS project that needs code hands off to a
> vibecoding surface, rather than growing one in place. Keep the section below as the record of what state 2
> would cost; do not build it without a fresh decision.

Behind its own **default-off flag** (CLAUDE.md checklist #7 — this is a boot/dispatch hot path).

- Start prompt → user-driven `lifecycle.start()`. Precedent: `content-browser.tsx:270`.
- Intent must not re-dress the workspace: while the pod is cold, tabs/console/origin stay as they are.
- Add an explicit **stop** control to the switch — gating the console on pod presence removes the preview
  drawer, today the only `onStop` for hosted pods.
- Drop the preview SSE when in CMS mode with no pending boot (`agent-shell-layout/index.tsx:283`), so a CMS
  tab stops renewing the pod claim every 5 minutes.
- Touch `shouldAutoStart` (`sandbox-lifecycle-context.tsx:66`) — it still auto-boots for non-gated projects,
  contradicting rule 1.
- Guard `start()` on `startVm.isPending` (`:749`), which the auto-start path already does.
- Re-gate `input.tsx:642` on pod absence, with **new copy** — the key's meaning changes.
- **Keep `draftPreviewUrl` keyed on the metadata gate**, not the mode. It is why entering vibecoding is not
  an iframe remount; re-keying it "for consistency" would turn that into a cross-origin navigation.
- Retire the nested pane + `Edit content` toggle (`preview.tsx:1845-1863, 1244`), and the **four**
  `activateEditingMode("blocks")` callers (`:999, 1164, 1215, 1643`). Collapse `PreviewEditingMode` to
  `"preview" | "visual"` and retire `cmsDefaultOpen` / `shouldAutoOpenCms` with it. Then `knip`.
- **The origin decision** (spec open question 1) — if taken: re-derive `previewOrigin` from the iframe's
  actual base, `null` during swaps, add the `e.source` check, and add an e2e asserting a wrong-origin message
  is rejected.

---

## Testing

Two tiers, no third ([`TESTING.md`](../../../TESTING.md)).

**Unit** — all proposed tests are over genuinely pure functions; nothing needs `mock.module` or a stubbed
context. Write phase cases against the **real** `LifecycleState["phase"]` union
(`idle | cloning | checking-out | installing | starting | running | crashed | clone-failed | install-failed | start-failed`)
— the first draft's `"cold"` does not exist.

Add: `redirectIfInvisible` for `git`/`content`/`code` covering **both** `activeTab` and `mainOpen` (the
existing asymmetry at `:316-319` is untested); `resolveCmsMode` legacy-key fallback; unknown search-param
degradation; `resolveWorkspacePanelAction` when the requested kind is unavailable.

`blocks-preview-workspace-state.test.ts:41-52` asserts the whole state object with `toEqual` — adding
`sectionClick` breaks it. (The reducer is in `blocks-preview-workspace-state.ts`, not `-context.tsx`.)

**E2E** — promote the CMS-project fixture out of `decofile-api.spec.ts:76-180` (per `TESTING.md:84`, second
use). Note `plugins/ban-e2e-app-imports.js` allows only `@playwright/test`, `pg`, `zod`,
`@modelcontextprotocol/sdk`, `@decocms/shared`.

**Cases 5–7 of the first draft are not writable** — no e2e boots a pod; the suite has no sandbox provider or
lifecycle SSE source. Scope them to what is observable (start prompt appears; tabs/console unchanged;
confirming issues exactly one `SANDBOX_START`) and move phase transitions to unit tests, or budget a
lifecycle-stub fixture.

**Inversions** — the first draft's three-string grep is insufficient. Files that break:
`use-layout-state.test.ts`, `source-system-tabs.test.ts`, `preview-display.test.ts`,
`blocks-tab-state.test.ts` (a whole `describe("sandbox-less Fast Preview")` whose premise this deletes),
`sandbox-lifecycle-context.test.ts`, `section-preview-url.test.ts`, `blocks-preview-workspace-state.test.ts`,
`decofile-api.spec.ts`, `standalone-blocks-panel.spec.ts`. Also `tab-id.test.ts:257`, which keeps passing
while its comment becomes a lie.

---

## Critique decisions

**Adopted**

- Deleted `WorkspaceMode`, `resolveWorkspaceMode`, `?mode=`, `committed` and `devFrameReady`. All four
  duplicated existing signals, `podPhase !== "cold"` referenced a non-existent phase, and
  `devFrameReady === "running"` was *weaker* than `resolvePreviewDisplay`'s existing rule.
- Tabs/console follow **pod presence**, not mode — removes the tab-bounce bug and the redirect logic.
- CMS mode requires the metadata gate; `hasEditableDecoContent` is not the availability signal.
- Rename extended to `apps/api` + `packages/shared`, write stays on the old key.
- Split into five PRs; added PR 0 (credential redaction) and PR 3 (de-duplication).
- Added: `resolveBlocksTabState`, `shouldAutoStart`, the CMS tour anchor, the six `SidePanelKind` literal
  sites, the stop control, the SSE/TTL renewal, `onActivate` in CMS mode, `draftPreviewUrl` staying keyed.
- Added a security section; corrected the rollback claim and the 250px width finding.
- Dropped per-kind panel width (speculative) and the first draft's unwritable e2e cases.

**Rejected**

- *"Cut the boot flow entirely."* Kept as PR 5 behind a default-off flag. It is the state the user explicitly
  asked to design, and gating it is enough to bound the risk.
- *"Keep the `Content` tab out of the switch's concerns."* No change needed — it already stays.

**The CMS exit ("the honest wall") — cut from this plan**

Sketched four options; the wall was preferred. It is **not** in any PR here. It is pre-existing (the same
wall exists in today's nested pane), so moving the panel neither creates nor worsens it — and the contextual
version I sketched is not buildable, because the block form has no signal for *what the editor wanted*. See
the spec's [The wall](./cms-mode-spec.md#the-wall--noted-deliberately-not-solved-here). If picked up, it is a
standalone ~2-i18n-key change that applies to the old pane and the new one alike.

**Revised again after PR #6054 merged**

- Dropped the `onActivate` guard from PR 4 — the collision it addressed no longer exists.
- Adopted the **mount-boundary pattern** as the governing rule, replacing "thread a mode into shared
  components". It was already the shape of PR 4; now it is precedent rather than invention.
- **Flipped my earlier rejection: PR 5 is now recommended for cutting.** The shipped code makes CMS ⟹ no pod
  structural, so state 2 costs more than it did when I kept it.
- PR 1 shrinks slightly — the new files already use CMS vocabulary (`cms-panel-state`, `cms-header-actions`,
  `thread.cmsActions.*`) while the gate is still `resolveFastPreview`, so the codebase is now *half*-renamed
  and inconsistent. That raises the value of finishing it.
- Noted `use-save-block` / `use-delete-block` now await status invalidation (shared with vibecoding).

**Adapted**

- *"Restrict scope to Fast Preview projects."* Adopted in substance — CMS mode requires the gate — but the
  **rename stands**, so the user-facing vocabulary is still two modes with no "Fast Preview" anywhere. The
  gate becomes "has a preview server", not a feature flag.
- *"Delete `PreviewEditingMode`'s `blocks` value."* Deferred to PR 5 where its three callers are removed,
  rather than done early.

---

## Checklist

- [ ] `bun run fmt` · `bun run lint` · `bun run check` · `bun test` · `knip`
- [ ] `bun run --cwd=apps/api generate:tool-contracts` (PR 1)
- [ ] pt-br **values** retranslated, not just keys renamed
- [ ] PR 5 ships default-off
- [ ] Screenshots: CMS mode, boot prompt, booting, vibecoding, unavailable-CMS project
