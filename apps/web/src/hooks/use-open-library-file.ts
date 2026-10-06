/**
 * The Library file the user has open, which the chat tells the agent about.
 * Desktop uses the `library-file` view; the panel and mobile dialog use
 * `?preview=`/`?skill=`/`?brand=`. Precedence mirrors the panel's own
 * (preview › skill › brand), and the view wins over both.
 *
 * Dismissing it (the composer chip's X) holds only for that file: opening
 * another one brings the chip, and the context, back.
 */

import { useSyncExternalStore } from "react";
import { useSearch } from "@tanstack/react-router";
import { parseLibraryFileTabId } from "@/layouts/main-panel-tabs/tab-id";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";

let dismissedPath: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setDismissed(path: string | null) {
  if (dismissedPath === path) return;
  dismissedPath = path;
  for (const listener of listeners) listener();
}

/** Opening a file, even the one dismissed, brings the chip back. Called from
 *  the open itself, so no render has to notice the change. */
export function clearOpenFileDismissal() {
  setDismissed(null);
}

export function useOpenLibraryFile(): {
  path: string;
  dismiss: () => void;
} | null {
  const search = useSearch({ strict: false }) as {
    preview?: string;
    skill?: string;
    brand?: string;
  };
  const activeTabId = useActivePanelTabId();
  const dismissed = useSyncExternalStore(
    subscribe,
    () => dismissedPath,
    () => dismissedPath,
  );
  const path =
    parseLibraryFileTabId(activeTabId)?.path ??
    search.preview ??
    search.skill ??
    search.brand ??
    null;
  if (!path || path === dismissed) return null;
  return { path, dismiss: () => setDismissed(path) };
}
