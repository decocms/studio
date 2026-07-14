# Blocks Tab Availability Design

## Goal

Make the Blocks tab visible whenever Preview is visible, then explain the
Blocks feature's actual availability inside the tab with distinct loading,
content, empty, and error states.

## Tab visibility

Preview, Blocks, and Code are source tabs. All three appear when the current
agent has clonable source, as determined by `agentHasClonableSource`. Blocks no
longer waits for the sandbox dev server or Deco metadata before appearing.

The Content tab keeps its existing, stricter availability condition.

## Blocks tab states

A dedicated `BlocksTab` reads the sandbox lifecycle and the existing
`.decofile` and `/live/_meta` React Query resources. It resolves one of four
states in this order:

1. **Error:** The sandbox reaches `clone-failed`, `install-failed`,
   `start-failed`, or `crashed`, or an initial Deco data request fails without
   cached data. The tab shows an error message and a Retry action. Sandbox
   errors retry the lifecycle; data errors refetch the Deco resources.
2. **Loading:** The sandbox is progressing toward `running`, or an initial Deco
   data request is still pending. The tab renders `MainPanelLoading`.
3. **Content:** The sandbox is running and `hasEditableDecoContent(decofile,
   meta)` is true. The tab renders the existing `PreviewTab` with
   `initialViewMode="cms"`.
4. **Empty:** The sandbox is running, both Deco data requests have settled, and
   the editable-content condition is false. The tab explains that the project
   does not expose editable Blocks content and links to
   <https://github.com/decocms/blocks> in a new tab.

Background refetches do not replace usable cached content with a loading or
error state.

## Components and data flow

- A small pure helper builds the source-tab list so the shared Preview/Blocks
  visibility rule is directly testable.
- A small pure state resolver converts lifecycle and query snapshots into the
  four Blocks states. `BlocksTab` remains responsible only for calling hooks
  and rendering the selected state.
- Existing `useDecofile` and `useLiveMeta` query keys remain unchanged. The tab
  bar, Content tab, Preview, and Blocks therefore share cached responses and
  deduplicate concurrent requests.
- The current Preview/CMS implementation remains unchanged; it is mounted only
  for the content state.

## Error and empty-state presentation

The error state uses the established full-panel empty-state layout with an
alert icon, concise failure copy, and a Retry button. The empty state uses the
same layout with a `View Blocks docs` action. External navigation uses
`target="_blank"` and `rel="noreferrer"`.

## Testing

Pure unit tests cover:

- source agents receiving Preview, Blocks, and Code together;
- non-source agents receiving none of those source tabs;
- forward lifecycle and initial query work resolving to loading;
- editable Deco data resolving to content;
- settled non-editable data resolving to empty;
- terminal lifecycle and initial query failures resolving to error;
- cached usable data remaining content during background refetches.

A lightweight render test covers the empty state's documentation link. Tests
use real pure functions/components and no mocked application hooks.

After implementation, run the focused tests, formatting, type checking, and
linting required by the repository.
