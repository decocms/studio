/**
 * Whether the New project dialog is open — module-scope state, read with
 * `useSyncExternalStore`, exactly like `command-palette-store.ts`.
 *
 * Creating a project is offered from four places that cannot share a parent:
 * the org home, the sidebar's project list, the org/project picker popover, and
 * the Reports and Settings indexes. The picker is the one that forces this:
 * it lives inside a popover, so a dialog it rendered would unmount with the
 * popover the moment the item was clicked.
 *
 * A store beats a context here for the same reason it does for the palette — a
 * context whose value is `[open, setOpen]` re-renders every consumer under the
 * shell on each toggle, and `openNewProjectDialog()` is a plain function any
 * module can call without being under a provider at all. The dialog itself is
 * mounted once, by the shell, and gated so it costs nothing while closed.
 */

import { useSyncExternalStore } from "react";
import { Store } from "@/components/chat/store/store-primitive";
import { track } from "@/lib/posthog-client";

const dialogOpen = new Store(false);
/** The surface that asked, for `project_create_*`. */
let openedFrom = "unknown";

export function openNewProjectDialog(source: string): void {
  openedFrom = source;
  track("project_create_clicked", { source });
  dialogOpen.set(true);
}

/** `useState`-shaped read, for the shell that renders the dialog. */
export function useNewProjectDialog(): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(dialogOpen.subscribe, dialogOpen.get);
  return [open, dialogOpen.set];
}

/** Which surface opened the dialog currently on screen. */
export function newProjectSource(): string {
  return openedFrom;
}
