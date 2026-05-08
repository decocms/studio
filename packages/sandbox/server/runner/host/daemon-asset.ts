/**
 * Embeds the prebuilt sandbox daemon bundle as a string at build time.
 *
 * Isolated in its own file so `host/runner.ts` can `await import()` it
 * lazily — that way tests using the `_spawn` test seam never trigger the
 * text-import resolution and don't require `daemon/dist/daemon.js` to
 * exist on disk.
 *
 * In production (bundled `server.js`), `bun build` inlines the daemon
 * bytes here so no asset has to ship alongside the bundle. The host
 * runner writes these bytes to disk on first spawn and points
 * `bun run` at the materialized file — see `host/runner.ts`.
 */

// @ts-expect-error - Bun-specific text loader attribute; TS resolves the
// underlying .js file and doesn't model `with { type: "text" }`.
import _daemonBundle from "../../../daemon/dist/daemon.js" with {
  type: "text",
};

export const DAEMON_BUNDLE: string = _daemonBundle;
