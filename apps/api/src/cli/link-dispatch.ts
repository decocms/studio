/**
 * Applies an interaction intent to the link store + daemon actions. Reads the
 * live store snapshot, derives the effective selection (mirrors the view), and
 * routes each intent to the right setter / action. Kept out of the view so the
 * whole interaction surface is unit-testable.
 */
import type { LinkIntent } from "./link-keymap";
import { nextSelection, orderedHandles } from "./link-selection";
import {
  getLinkState,
  removeSandboxRow,
  setActionError,
  setPendingConfirm,
  setRemoving,
  setSelectedHandle,
} from "./link-store";
import { openPreviewUrl } from "./open-url";

export interface DispatchDeps {
  openUrl?: (url: string) => void;
}

export function dispatchIntent(
  intent: LinkIntent,
  deps: DispatchDeps = {},
): void {
  const openUrl = deps.openUrl ?? openPreviewUrl;
  const state = getLinkState();
  const handles = orderedHandles(state.sandboxes);
  const current =
    state.selectedHandle !== null && handles.includes(state.selectedHandle)
      ? state.selectedHandle
      : (handles[0] ?? null);
  const actions = state.actions;

  switch (intent.type) {
    case "move":
      // Use the raw stored selection so the first keypress seeds to an edge
      // (nextSelection maps null → first/last) instead of stepping past it.
      setSelectedHandle(
        nextSelection(handles, state.selectedHandle, intent.delta),
      );
      return;
    case "open": {
      if (current === null) return;
      const row = state.sandboxes.get(current);
      if (row?.status === "ready" && row.previewUrl) openUrl(row.previewUrl);
      return;
    }
    case "stop":
      if (current !== null && actions) void actions.stopSandbox(current);
      return;
    case "delete": {
      if (current === null || !actions) return;
      const info = actions.inspectSandbox(current);
      const row = state.sandboxes.get(current);
      setActionError(null);
      setPendingConfirm({
        handle: current,
        branch: info?.branch ?? row?.branch ?? null,
        dirtyCount: info?.dirtyCount ?? 0,
        merged: info?.merged ?? null,
      });
      return;
    }
    case "confirmYes": {
      const confirm = state.pendingConfirm;
      setPendingConfirm(null);
      if (confirm === null || !actions) return;
      setRemoving(confirm.handle, true);
      void actions.removeSandbox(confirm.handle).then((res) => {
        if (res.ok) {
          removeSandboxRow(confirm.handle);
        } else {
          setRemoving(confirm.handle, false);
          setActionError(res.error);
        }
      });
      return;
    }
    case "confirmNo":
      setPendingConfirm(null);
      return;
    case "quit":
      if (actions) void actions.quit();
      return;
  }
}
