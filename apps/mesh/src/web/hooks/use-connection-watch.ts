/**
 * SSE file-watch hook for local-dev connections.
 *
 * Connects to the /watch endpoint of a local-dev daemon and fires a callback
 * whenever files change. Used to invalidate git queries reactively instead
 * of polling.
 *
 * Only activates for localhost connection URLs (local-dev daemons).
 */

// oxlint-disable-next-line ban-use-effect/ban-use-effect
import { useEffect, useRef } from "react";

interface WatchEvent {
  path: string;
  type: string;
  timestamp: number;
}

/**
 * Derive the /watch SSE URL from a connection's MCP URL.
 * Returns null for non-localhost connections.
 */
function getWatchUrl(connectionUrl: string | undefined): string | null {
  if (!connectionUrl) return null;
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

/**
 * Subscribe to a local-dev daemon's /watch SSE endpoint.
 * Calls `onChange` when file changes are detected.
 * Debounces rapid bursts (e.g. git operations) to a single callback.
 *
 * Returns a `pause`/`resume` control object so callers can suppress
 * events during bulk git operations (e.g. branch checkout).
 */
export function useConnectionWatch(
  connectionUrl: string | undefined,
  onChange: () => void,
): { pause: () => void; resume: () => void } {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const pausedRef = useRef(false);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    const watchUrl = getWatchUrl(connectionUrl);
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
  }, [connectionUrl]);

  return {
    pause: () => {
      pausedRef.current = true;
    },
    resume: () => {
      pausedRef.current = false;
    },
  };
}
