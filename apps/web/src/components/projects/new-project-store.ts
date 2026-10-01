/**
 * Whether the New project dialog is open — module-scope state read with
 * `useSyncExternalStore`, exactly like `command-palette-store.ts`.
 *
 * Creating a project is offered from places that cannot share a parent, and the
 * picker forces the store: it lives in a popover, so a dialog it rendered would
 * unmount with the popover the moment the item was clicked.
 */

import { useSyncExternalStore } from "react";
import { Store } from "@/components/chat/store/store-primitive";
import { track } from "@/lib/posthog-client";

const dialogOpen = new Store(false);
/** The surface that asked, for `project_create_*`. */
let openedFrom = "unknown";
/** What the surface that asked does with the new project, e.g. file it in a
 *  folder. Cleared on every open, so it never outlives its request. */
let onCreated: ((projectId: string) => void) | null = null;

export function openNewProjectDialog(
  source: string,
  options?: { onCreated?: (projectId: string) => void },
): void {
  openedFrom = source;
  onCreated = options?.onCreated ?? null;
  track("project_create_clicked", { source });
  dialogOpen.set(true);
}

/** `useState`-shaped read, for the shell that renders the dialog. */
export function useNewProjectDialog(): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(dialogOpen.subscribe, dialogOpen.get);
  return [open, dialogOpen.set];
}

/** Hand the new project to whoever opened the dialog, once. */
export function notifyNewProjectCreated(projectId: string): void {
  const callback = onCreated;
  onCreated = null;
  callback?.(projectId);
}

/** Which surface opened the dialog currently on screen. */
export function newProjectSource(): string {
  return openedFrom;
}
