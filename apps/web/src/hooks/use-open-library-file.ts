/**
 * The Library file the user has open, which the chat tells the agent about.
 * Desktop uses the `library-file` view; the panel and mobile dialog use
 * `?preview=`/`?skill=`/`?brand=`. Precedence mirrors the panel's own
 * (preview › skill › brand), and the view wins over both.
 *
 * Dismissing it (the composer chip's X) holds only while that file stays open
 * in that org and thread: closing it, opening another, or switching chats
 * brings the chip, and the context, back — however the file was opened.
 */

import { useSyncExternalStore } from "react";
import { useSearch } from "@tanstack/react-router";
import { useProjectContext } from "@/sdk";
import { useRouteThreadId } from "@/layouts/thread-route";
import { parseLibraryFileTabId } from "@/layouts/main-panel-tabs/tab-id";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";

/** `org:thread:path` of the dismissed file. */
let dismissedKey: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setDismissed(path: string | null) {
  if (dismissedKey === path) return;
  dismissedKey = path;
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
  const { org } = useProjectContext();
  const threadId = useRouteThreadId();
  const dismissed = useSyncExternalStore(
    subscribe,
    () => dismissedKey,
    () => dismissedKey,
  );
  const path =
    parseLibraryFileTabId(activeTabId)?.path ??
    search.preview ??
    search.skill ??
    search.brand ??
    null;
  if (!path) {
    /** Closed: a reopen must show the chip again. Silent, because no reader
     *  shows anything for a closed file, and idempotent, so safe in render. */
    dismissedKey = null;
    return null;
  }
  const key = `${org.id}:${threadId ?? ""}:${path}`;
  if (key === dismissed) return null;
  return { path, dismiss: () => setDismissed(key) };
}
