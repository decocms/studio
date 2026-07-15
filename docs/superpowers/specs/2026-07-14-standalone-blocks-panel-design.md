# Standalone Blocks Panel Design

## Goal

Make Blocks a first-class workspace panel alongside Chat and Main. Blocks can
be opened or closed without changing Chat visibility, Main visibility, or the
active Main tab.

The desktop shell has three peer panels:

```text
Chat | Blocks | Main
```

Main keeps the existing tab system, including Preview, Code, Automations,
Settings, Review changes, and agent-provided views.

## Delivery stages

The change is delivered in two explicit stages.

### Stage 1: restore separate Preview and Blocks tabs

Restore the behavior that preceded commit `e25f039`:

- restore distinct `PreviewTab` and `BlocksTab` components;
- render them through separate branches in `MainPanelContent`;
- key their error boundaries independently; and
- restore the normal active-tab toggle behavior, where clicking active Blocks
  closes Main instead of selecting Preview.

This stage provides a known, independently verifiable baseline before Blocks
moves out of Main.

### Stage 2: promote Blocks to a workspace panel

Remove Blocks from the Main tab registry and add it as a persistent panel in
the shell's resizable panel group. Its toolbar button moves beside the Chat
toggle and reflects Blocks visibility rather than the active Main tab.

Preview remains an ordinary Main tab. Opening Blocks while Preview is active
produces `Chat | Blocks | Preview`; opening Blocks while Code is active
produces `Chat | Blocks | Code`.

## Visibility and URL state

Desktop visibility has three independent inputs:

- `?chat=0|1` controls Chat;
- `?blocks=0|1` controls Blocks; and
- `?main=<tabId>|0` controls Main and its active tab.

Opening or closing Blocks changes only `blocks`. It never changes `chat`,
`main`, or the selected Main tab. Opening or closing Chat similarly leaves
Blocks and Main untouched. Main retains its existing tab selection behavior.

At least one panel must remain visible. The toggle for the final visible panel
is disabled until another panel is opened.

Blocks defaults to closed when no explicit Blocks state or legacy Blocks
default exists. Existing `?main=blocks` links and agent layouts whose default
Main view is Blocks resolve to a Blocks-only workspace. This preserves saved
links and defaults while removing Blocks from the new Main tab grammar.

## Desktop layout

The existing two-panel `ChatMainPanelGroup` becomes a three-panel workspace
group. Chat, Blocks, and Main are peer resizable panels with collapsible size
zero. The layout helper computes valid sizes for every non-empty combination,
including all three panels open.

Blocks stays mounted while collapsed, matching Chat. Reopening it therefore
preserves editor navigation and transient form UI. Main also keeps its active
tab while collapsed.

The panel group owns the panel chrome, resize handles, and stored widths.
Feature components own only their content and visibility actions.

## Mobile layout

Mobile remains a single full-screen surface. Chat, Blocks, and Main are
mutually exclusive there: selecting one replaces the visible surface.

The mobile controls still use the same URL fields, but mobile actions close the
previously visible surface as necessary. Desktop is the only layout that shows
multiple panels simultaneously and guarantees independent open/close actions.

## Blocks and Preview component split

The current Blocks surface combines the Sections editor and live Preview
inside one `PreviewContent` component. The standalone design splits those
responsibilities:

- `BlocksPane` owns the page/block navigator and `SectionsEditor`;
- `PreviewPane` owns the live iframe and Preview controls; and
- a small workspace provider above the three panels owns shared content
  selection and optional Preview coordination, but owns no panel visibility.

Blocks remains usable when Preview is closed or when another Main tab is
active. It does not require a mounted iframe. When Preview is mounted, page
selection and saves can navigate or reload it through the provider. When
Preview is absent, the same Blocks actions continue to edit persisted Blocks
content without error.

Once this split is complete, remove the Preview-owned secondary CMS panel
path. The Blocks editor is rendered directly in the Blocks panel rather than
being portaled out of Preview.

## Availability and failure isolation

The Blocks toolbar toggle uses the same clonable-source capability gate that
currently exposes the source tabs. Preview and Code remain Main source tabs.
Content keeps its existing stricter editable-content gate.

The existing Blocks state resolver remains responsible for loading, content,
empty, and error states:

- sandbox or metadata work renders within Blocks only;
- Blocks retry actions affect only the relevant sandbox/data request;
- Preview failures cannot replace or close Blocks; and
- Blocks failures cannot change Main, its selected tab, or Chat.

## Testing

Pure unit tests cover:

- independent Chat, Blocks, and Main visibility state;
- prevention of an all-closed desktop layout;
- panel sizes for every non-empty visibility combination;
- legacy `?main=blocks` and Blocks-default migration;
- removal of Blocks from the Main source-tab list while retaining Preview and
  Code; and
- normal active-Main-tab close behavior after the Stage 1 restoration.

Black-box E2E coverage verifies:

- Preview remains selected while Blocks and Chat are toggled independently;
- Chat, Blocks, and Preview can be visible simultaneously on desktop;
- Blocks stays open when Main switches among Preview, Code, and Settings;
- Blocks state and editor navigation survive collapse and reopen;
- the final visible panel cannot be closed; and
- mobile displays only the selected Chat, Blocks, or Main surface.

After each stage, run focused tests. Before completion, run formatting, type
checking, linting, and the relevant E2E test in accordance with repository
guidelines.
