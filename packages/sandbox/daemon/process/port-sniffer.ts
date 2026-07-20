import { WELL_KNOWN_STARTERS } from "../constants";

/**
 * Most dev tools advertise their bind URL on stdout once they're up:
 *   vite:  `Local:   http://localhost:5174/`
 *   next:  `- Local:        http://localhost:3000`
 *   bun:   `Listening on http://localhost:3000`
 *   fresh: `Listening on http://0.0.0.0:8000/`
 *
 * The probe needs a port to HEAD-check. Studio sets `application.port` and
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
 *
 * The match requires one of the banner phrases above on the same line as
 * the URL — a bare `http://localhost:N` isn't enough. `dev`/`start` often
 * run more than one process (e.g. `concurrently "vite" "node server.js"`),
 * and their stdout interleaves on the same stream; without the phrase gate
 * an unrelated URL logged by a sibling process (a backend's own "listening"
 * line, a proxied fetch, ...) could win the lock before the real bind line
 * ever arrives.
 */

const URL_PATTERN =
  /(?:Local:|Listening on)[^\n]*?\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/;

/** ANSI color/cursor escape regex shared with the booting overlay. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars
// oxlint-disable-next-line no-control-regex
const ANSI = /\[[0-9;?]*[a-zA-Z]/g;

/**
 * PTY reads (`child.onData`) aren't line-buffered — a chunk boundary can
 * land mid bind-line (e.g. "...Local:   http://localhost:30" | "00/\n").
 * Matching each chunk in isolation would miss the announcement forever.
 * Carry a bounded tail per source across calls so a split line still
 * matches once its continuation arrives. The longest phrase+URL we need
 * to span is well under 100 chars, so 200 leaves headroom.
 */
const CARRY_LIMIT = 200;

export interface PortSniffer {
  /**
   * Inspect a log chunk. No-op when not a starter source, when a port is
   * already locked in, or when the chunk has no recognizable bind URL.
   * Returns true only on the chunk that first locks a port in — that bind
   * announcement is the dev server telling us it's ready, so the caller can
   * kick the probe immediately instead of waiting for its next poll tick.
   */
  observe(source: string, data: string): boolean;
  /** Currently sniffed port, or null if nothing's been detected. */
  current(): number | null;
  /** Drop the locked-in port — the next observe() can sniff again. */
  reset(): void;
}

export function createPortSniffer(): PortSniffer {
  let port: number | null = null;
  const carry = new Map<string, string>();
  return {
    observe(source, data) {
      if (port !== null) return false;
      if (
        !WELL_KNOWN_STARTERS.includes(
          source as (typeof WELL_KNOWN_STARTERS)[number],
        )
      )
        return false;
      const combined = (carry.get(source) ?? "") + data.replace(ANSI, "");
      const match = combined.match(URL_PATTERN);
      if (!match) {
        carry.set(source, combined.slice(-CARRY_LIMIT));
        return false;
      }
      const parsed = Number(match[1]);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        carry.set(source, combined.slice(-CARRY_LIMIT));
        return false;
      }
      carry.delete(source);
      port = parsed;
      return true;
    },
    current() {
      return port;
    },
    reset() {
      port = null;
      carry.clear();
    },
  };
}
