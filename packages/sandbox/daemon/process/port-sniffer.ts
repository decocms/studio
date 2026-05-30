import { WELL_KNOWN_STARTERS } from "../constants";

/**
 * Most dev tools advertise their bind URL on stdout once they're up:
 *   vite:  `Local:   http://localhost:5174/`
 *   next:  `- Local:        http://localhost:3000`
 *   bun:   `Listening on http://localhost:3000`
 *   fresh: `Listening on http://0.0.0.0:8000/`
 *
 * The probe needs a port to HEAD-check. Mesh sets `application.port` and
 * exports it as `PORT`, but most frameworks (vite included) ignore that
 * env unless the project's config reads it explicitly. Worse, on the host
 * runner two sandboxes can race for the same default port — vite then
 * silently falls back to the next free one. That mismatch leaves the
 * probe checking a dead port forever.
 *
 * The sniffer feeds the probe the port it actually saw the dev script
 * announce. First valid match wins until `reset()`; we never overwrite a
 * locked-in port from a later log line, so a log message that happens to
 * contain another `http://localhost:N/` (e.g. an outbound fetch) can't
 * retarget the probe.
 */

const URL_PATTERN = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/;

/** ANSI color/cursor escape regex shared with the booting overlay. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars
// oxlint-disable-next-line no-control-regex
const ANSI = /\[[0-9;?]*[a-zA-Z]/g;

export interface PortSniffer {
  /**
   * Inspect a log chunk. No-op when not a starter source, when a port is
   * already locked in, or when the chunk has no recognizable bind URL.
   */
  observe(source: string, data: string): void;
  /** Currently sniffed port, or null if nothing's been detected. */
  current(): number | null;
  /** Drop the locked-in port — the next observe() can sniff again. */
  reset(): void;
}

export function createPortSniffer(): PortSniffer {
  let port: number | null = null;
  return {
    observe(source, data) {
      if (port !== null) return;
      if (
        !WELL_KNOWN_STARTERS.includes(
          source as (typeof WELL_KNOWN_STARTERS)[number],
        )
      )
        return;
      const stripped = data.replace(ANSI, "");
      const match = stripped.match(URL_PATTERN);
      if (!match) return;
      const parsed = Number(match[1]);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return;
      port = parsed;
    },
    current() {
      return port;
    },
    reset() {
      port = null;
    },
  };
}
