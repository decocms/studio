/**
 * Agent `preview_navigate` calls, from the chat stream to the Preview.
 *
 * The path becomes the preview's last visited page, which a Preview restores
 * when it mounts; a Preview already mounted is told directly.
 */

import { useEffect, useRef } from "react";
import { z } from "zod";
import { writeLastPreviewPage } from "./last-preview-page";

export const PreviewNavigateInputSchema = z.object({ path: z.string() });

type NavigateHandler = (path: string) => void;

/** Mounted Previews, by their last-page storage key. */
const handlers = new Map<string, Set<NavigateHandler>>();

const PROBE_BASE = "http://preview.invalid";

/**
 * The agent's path as a same-origin path (pathname + query + hash), or null
 * when it would resolve off the dev server (`//host`, `/\host`, a full URL).
 * The tool input is model output, so it is checked before it loads.
 */
export function sameOriginPreviewPath(path: string): string | null {
  try {
    const url = new URL(path, PROBE_BASE);
    if (url.origin !== PROBE_BASE) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

export function requestPreviewNavigate(storageKey: string, path: string) {
  const safePath = sameOriginPreviewPath(path);
  if (!safePath) return;
  writeLastPreviewPage(storageKey, {
    path: safePath,
    pageKey: null,
    params: {},
  });
  for (const handler of handlers.get(storageKey) ?? []) handler(safePath);
}

export function usePreviewNavigateHandler(
  storageKey: string | null,
  handler: NavigateHandler,
) {
  const handlerRef = useRef(handler);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- latest handler for a stable subscription, as in useSandboxReloadHandler
  handlerRef.current = handler;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- subscription lifecycle bound to the Preview's mount
  useEffect(() => {
    if (!storageKey) return;
    const fn: NavigateHandler = (path) => handlerRef.current(path);
    let set = handlers.get(storageKey);
    if (!set) {
      set = new Set();
      handlers.set(storageKey, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) handlers.delete(storageKey);
    };
  }, [storageKey]);
}
