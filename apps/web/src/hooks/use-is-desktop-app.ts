/**
 * Detects whether this bundle is the Tauri desktop app (`apps/native`)
 * rather than the plain web build.
 *
 * Single source of truth: the `VITE_TAURI_APP` build-time env var. It is set
 * to `"1"` only by `apps/web`'s `build:native` (`VITE_TAURI_APP=1 vite
 * build`) and `dev:native` (the HMR dev server tauri.conf's `devUrl` points
 * at), and is `"0"` for the standard web `build:web`/`dev`. The desktop app
 * only ever loads `VITE_TAURI_APP=1` modules — the packaged app from Tauri's
 * `frontendDist`, `tauri dev` from that `dev:native` server — so "built for
 * desktop" and "running inside the Tauri webview" coincide exactly.
 *
 * The same flag drives the Vite entry-point split (`vite.config.ts`) and this
 * gate, so there is ONE knob for all desktop-vs-web behavior — do not add a
 * second detection mechanism. Every desktop-vs-web gate goes through this
 * helper.
 *
 * Capability vs. gating: this answers "is this the desktop build", NOT "is the
 * Tauri IPC bridge actually present in this window". Those differ when the
 * desktop bundle is loaded outside Tauri (e.g. `vite preview`, or opening
 * the built `index.native.html` directly in a browser): the build flag is still
 * `"1"` but there is no IPC bridge. Code that makes real `invoke()` calls must
 * therefore probe the bridge directly with `"__TAURI_INTERNALS__" in window`,
 * not this gate — see `lib/desktop/tauri-bridge.ts`'s `assertDesktopEnvironment`.
 */

/**
 * Pure, dependency-free check — safe to call anywhere (module init,
 * non-component code, SSR, tests). Because `VITE_TAURI_APP` is a build-time
 * constant, Vite/Rollup replaces it with a literal and dead-code-eliminates the
 * untaken branch out of each bundle. `false` in the web build and under
 * `bun test` (where `import.meta.env.VITE_TAURI_APP` is `undefined`).
 */
export function isDesktopAppEnvironment(): boolean {
  return import.meta.env.VITE_TAURI_APP === "1";
}

/**
 * React hook wrapper around `isDesktopAppEnvironment()`. The value is a
 * build-time constant that never changes for the life of the session, so this
 * needs no state/subscription — a direct call is correct and re-evaluates for
 * free on every render.
 */
export function useIsDesktopApp(): boolean {
  return isDesktopAppEnvironment();
}
