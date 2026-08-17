# CMS mode / Vibecoding mode — spec

**Status:** proposed, revised after critique · **Scope:** `apps/web` shell, preview, side panel · `apps/api` gate

> Revised after a 7-perspective review. Five load-bearing claims in the first draft were false against
> source. See [Critique decisions](./cms-mode-plan.md#critique-decisions) in the plan.

## Summary

Studio's editing workspace has two audiences and one undifferentiated UI. This spec gives it two modes:

| Mode | For | Cost |
| --- | --- | --- |
| **CMS mode** | Content editors. Blocks, copy, images, page layout. | Free — *when the project has a preview server* |
| **Vibecoding mode** | Developers. Components, logic, dependencies. | A pod, ~1 min boot |

"Fast Preview" is retired as a **name**. It survives as a **prerequisite**: CMS mode is only pod-less on
projects with a preview server URL, because that is the only configuration where the decofile is reachable
over HTTP instead of through the sandbox daemon.

---

## The prerequisite (corrected)

The first draft claimed CMS mode is free wherever a site has content. **That is false**, and it is the
correction that most changes the design.

The pod-less CMS data path exists only behind the persisted gate:

| Operation | Gate on | Gate off |
| --- | --- | --- |
| Read decofile | `fetchDecofile` — GitHub API (`use-decofile.ts:55`) | `readCommittedJson` — **through the daemon** |
| Write block | `patchDecofile` — GitHub API (`use-save-block.ts:51`) | `POST …/sandbox/…/write` — **the pod's filesystem** |
| Panel state | bypasses lifecycle (`blocks-tab-state.ts:44`) | `classifyPhase("idle")` → `loading`, **forever** |

Server-side the same gate guards the route CMS mode runs on: `decofile.ts:124` 404s without it, and
`sandbox-proxy.ts:213` needs it to answer `/git/*` from GitHub.

Two consequences:

1. **CMS mode requires a preview server URL.** Without one there is no free mode — the honest product answer
   is "set a preview server to enable CMS mode", surfaced in settings, not a mode that spins forever.
2. **`hasEditableDecoContent` cannot be the availability signal.** It is derived from the decofile, which off
   the gate needs a pod. You would have to boot to discover you did not need to. Availability is the
   **metadata gate**; content presence only decides whether the panel has anything to show.

```
cmsModeAvailable = resolveCmsMode(metadata).active     // cmsMode|fastPreview && previewServerUrl
```

---

## Model — derived, not invented

The first draft added a `WorkspaceMode` enum, a `?mode=` search param, and `committed` / `devFrameReady`
booleans. **All four are deleted.** Every signal already exists:

| Concept | Source of truth |
| --- | --- |
| Which mode the user wants | `SidePanelKind` — `"chat" \| "cms"`, already in the URL |
| Is there a pod | `vmEntry` in the sandbox lifecycle — the same predicate `shouldAutoStart` uses |
| Is the dev server showable | `resolvePreviewDisplay` — keep its `progressStatus !== "doing"` rule, which deliberately admits `failed`/`crashed` so the daemon status page renders |
| Is CMS worth offering | `resolveCmsMode(metadata).active` |

One intent bit, already in the URL, already persisted per thread. A second `?mode=` param would be a second
copy of the same intent that must be kept in lockstep — and `?mode=code&sidepanel=cms` would be constructible.

**Mode is `sidePanel === "cms" ? "cms" : "code"`.** Nothing more.

### Tabs and console follow the pod, not the panel

The first draft keyed tabs on the mode. That is a state-loss bug: a developer with a pod running who opens
the CMS panel to fix a paragraph would lose Code and Review changes, and get bounced off whichever tab they
were on.

- **Code · Review changes · console** ← **a pod exists**
- **Side panel contents** ← `SidePanelKind`
- **Preview origin** ← `resolvePreviewDisplay`, unchanged rules

This removes the redirect logic the first draft needed, and fixes the bounce for free.

---

## Rules

### In scope

1. **CMS mode requires a preview server URL** — see [The prerequisite](#the-prerequisite-corrected).
2. **No switch when CMS is unavailable.** The control disappears rather than showing a disabled half.
3. **Side panel contents follow `SidePanelKind`; tabs and console follow pod presence.** A developer with a
   pod who opens the CMS panel keeps Code and Review changes — the panel kind must not bounce them off a tab.

### Parked with PR 5 (the boot flow)

These only bind once a CMS project can boot a pod. Recorded so they are not rediscovered late.

4. **Entering vibecoding is explicit and costed.** Never auto-start on a stray click — `shouldAutoStart` is
   gated because an accidental start once leaked one pod per new chat (`sandbox-lifecycle-context.tsx:50`).
5. **Cold vs. warm is visible on the switch**, and the warm dot is the **stop** control — see rule 6.
6. **Leaving vibecoding does not kill the pod, but the user must be able to.** Gating the console on pod
   presence would remove the preview drawer, which today holds the only `onStop` for hosted pods
   (`preview-drawer-host.tsx:115`). *No regression today, because CMS mode has no pod to stop.*
7. **A CMS tab should not hold a pod claim open.** The preview SSE calls `renewTtl` every 5 minutes
   (`sandbox-events-handler.ts:124`), extending shutdown for as long as a tab is open. *Only reachable if a
   CMS tab can coexist with a pod.*
8. **CMS keeps working while a pod runs — with one caveat.** Reads go to the GitHub branch head while the
   agent edits the working tree. Two content sources on one screen; which wins is an open question.

---

## Security

**For PRs 1–4: nothing new.** The panel move changes which column renders the block editor. It does not
touch the preview iframe's origin, does not enable canvas click-through, and does not promote the console.
Each of those was a consequence of the boot flow, which is cut.

The three findings below are **gates on PR 5**, recorded so they are not rediscovered late if it is revived.
The first is also a live bug worth filing independently of this work.

**Daemon console leaks a credential.** `clone.go:444` puts the clone URL in argv, `:92` echoes argv verbatim,
and `broadcast.go:94` keeps it in the replay buffer — so `https://x-access-token:ghs_…@github.com/…` is
readable after boot. **Pre-existing and not promoted by this work** (CMS mode implies no pod, so the console
is shown to exactly the same people as today). File it on its own.

**The origin trust boundary — a gate on click-through.** `previewOrigin` derives the postMessage allow-list
from the *sandbox* URL (`preview.tsx:876`), and `preview.tsx:1981` deliberately skips editor injection for
non-sandbox frames: *"the production fallback is a view-only, cross-origin frame."* With no pod,
`previewOrigin` returns `null` (`:194-200`) and both the listener and the injection are already inert — so
**click-through does not work in CMS mode today, and PR 4 shipping list-driven-only is not a regression.**
Making it work means injecting `CMS_EDITOR_SCRIPT` into the customer's production origin and trusting
messages back: a real trust-boundary expansion, an explicit decision, never a refactor side effect. If taken,
derive `previewOrigin` from the URL **currently in the iframe** (five call sites: `:876, 915, 925, 932, 954`),
`null` during swaps, never `"*"`, and add `e.source === previewIframeRef.current?.contentWindow`.

**Authorization — a gate on the boot button.** `SANDBOX_START` sits under `basic-usage`, so any org member
can provision compute. Only matters once a boot button is put in front of editors.

---

## Open questions

1. **Do we take the injection trust-boundary expansion?** If not, canvas click-through does not work in CMS
   mode and the panel is list-driven only.
2. **Which content source wins** when the gate is on and a pod is running — GitHub branch head or the
   working tree?
3. **Per-org concurrent-pod cap.** None exists. Out of scope, but it should be a ticket.

## The wall — noted, deliberately not solved here

An editor who needs a field that does not exist cannot get it in CMS mode, and the gate is per-project
(`header-info.tsx:22`), so there is no sibling code thread to hand off to. Decision: **out of scope**, on two
grounds.

**It is pre-existing.** Editors hit the identical wall today in the nested blocks pane. Moving the panel
neither creates nor worsens it, so it fails the scope test even though it is a real gap.

**The responsive version is not buildable.** A message that reacts to *what the editor wanted* needs an
intent signal, and the block form has none — it renders the fields that exist and never learns which one you
wished for. Only a static, always-on note is implementable without adding a prompt box, i.e. without adding
the chat CMS mode does not have.

If it is picked up later it is its own change, independent of the panel move and applying equally to the old
pane and the new one: a static note on the block form plus two i18n keys, optionally deep-linking to the
component via `__resolveType` (`parse-sections.ts:31`). CMS mode already ships `viewOnGithub` /
`resolveOnGithub`, so an external link is the established shape.

## The governing pattern: branch at the mount, don't thread a mode

PR #6054 (merged) settled this, and the code says why:

> *"Fast Preview swaps in the CMS renderer **here, not inside `HeaderActions`**, so the sandbox hooks that
> renderer mounts (events, lifecycle, publish gate) never mount on a surface that has no sandbox."*
> — `views/virtual-mcp/header-info.tsx:11-15`

So the rule is **not** "thread a `mode` parameter into shared components". It is: at the boundary, mount a
different component. `SelectCmsHeaderButtonInput` takes branch, PR, checks, reviews and in-flight flags —
**no pod, no lifecycle, no mode enum**. The gate stays `resolveCmsMode(metadata).active`, read at mount
points.

This is simpler than the first draft's "re-key the gates" approach and it is already precedent. Where a
surface cannot be swapped wholesale (the preview canvas), keep the existing pure function's own rules and
change only its inputs — never invent a parallel one.

**Consequence for rule 7.** The shipped design assumes CMS ⟹ no pod, structurally, at the mount. A CMS
project that also runs a pod is now *harder* than before #6054, not easier — see the plan's note on PR 5.

## Already solved by #6054

- **The header action bar in CMS mode.** `CmsHeaderActions` + `cms-panel-state.ts` (7 states, ~90 unit
  tests) replace the 21-state vibecoding machine. The five dead-click actions are gone.
- **The `send()` / `openSidePanel("chat")` collision** the first draft called "not free". CMS mode never
  mounts `HeaderActions`, so there is nothing to disable. Dropped from scope.
- **`usePublishGate` and its 10s GitHub poll** are off the CMS path entirely.

## Reusable from #6054

- **`isCmsStateSettling()`** and its rule — *never render a confident state from data a pending operation is
  about to change; every busy flag spans its own follow-up read*. This applies directly to the mode switch
  and any boot UI.
- **`SplitButton`** (`packages/ui`) — `disabled` disables only the primary half, so an inert pill can still
  offer menu actions.
- **`isCheckFailed` / `isCheckInProgress`**, newly exported from `panel-state.ts`.

## Out of scope

- **The `Content` main-panel tab.** Stays — `ContentBrowser` browses everything; the side panel edits the
  current page.
- **The sidebar thread list.** Unchanged.
- **The vibecoding header bar.** Untouched by this work.
