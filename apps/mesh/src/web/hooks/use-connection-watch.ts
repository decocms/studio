/**
 * SSE file-watch hook for local-dev connections.
 *
 * Connects to the watch endpoint and fires a callback whenever files change.
 * Used to invalidate git queries reactively instead of polling.
 *
 * Supports both:
 * - Local connections (via /api/local-dev/watch/:connectionId)
 * - External localhost connections (via connection_url derived /watch)
 */

// oxlint-disable-next-line ban-use-effect/ban-use-effect
import { useEffect, useRef } from "react";

interface WatchEvent {
  path: string;
  type: string;
  timestamp: number;
}

/**
 * Derive the watch SSE URL.
 * - For local connections (connectionId provided, no URL): use /api/local-dev/watch/:id
 * - For external localhost connections: derive from connection URL
 */
function getWatchUrl(
  connectionId: string | undefined,
  connectionUrl: string | undefined,
): string | null {
  // Local connection — use our API endpoint
  if (connectionId && !connectionUrl) {
    return `/api/local-dev/watch/${connectionId}`;
  }
  // External connection — derive from URL
  if (connectionUrl) {
    try {
      const url = new URL(connectionUrl);
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        return null;
      }
      return `${url.protocol}//${url.host}/watch`;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Subscribe to a local-dev watch SSE endpoint.
 * Calls `onChange` when file changes are detected.
 * Debounces rapid bursts (e.g. git operations) to a single callback.
 *
 * Returns a `pause`/`resume` control object so callers can suppress
 * events during bulk git operations (e.g. branch checkout).
 */
export function useConnectionWatch(
  connectionId: string | undefined,
  connectionUrl: string | undefined,
  onChange: () => void,
): { pause: () => void; resume: () => void } {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const pausedRef = useRef(false);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    const watchUrl = getWatchUrl(connectionId, connectionUrl);
    if (!watchUrl) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let es: EventSource | null = null;

    try {
      es = new EventSource(watchUrl);

      es.onmessage = (event) => {
        if (pausedRef.current) return;

        try {
          const data = JSON.parse(event.data) as WatchEvent;
          // Ignore node_modules, .git internals, etc.
          if (
            data.path.includes("node_modules") ||
            data.path.startsWith(".git/")
          ) {
            return;
          }
        } catch {
          // Not JSON — skip
          return;
        }

        // Debounce: wait 500ms after last change before firing
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          onChangeRef.current();
        }, 500);
      };

      es.onerror = () => {
        // EventSource auto-reconnects, nothing to do
      };
    } catch {
      // EventSource not available or URL invalid
    }

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      es?.close();
    };
  }, [connectionId, connectionUrl]);

  return {
    pause: () => {
      pausedRef.current = true;
    },
    resume: () => {
      pausedRef.current = false;
    },
  };
}
