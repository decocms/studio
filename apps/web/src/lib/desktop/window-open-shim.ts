/**
 * Makes `window.open` work inside the Tauri webview.
 *
 * WKWebView has no popup or tab concept and Tauri spawns no webview for
 * `window.open`, so it returns `null` unconditionally — verified live for both
 * `https://` and custom schemes like `vscode://`. Every "open in a new tab"
 * affordance in the app therefore does nothing at all on the desktop: no tab,
 * no error, no feedback. That is ~25 call sites across ~17 files (billing and
 * paywall links, GitHub PR links, blog and deck previews, file downloads, the
 * share deeplink, and the Open in VSCode/Cursor buttons).
 *
 * Shimming the global fixes all of them, and any added later, without editing
 * a single shared component — the alternative is touching every one of those
 * files to call a helper, which is a large diff across code the desktop
 * otherwise shares unmodified with the web app. Installed only when the Tauri
 * IPC bridge is actually present, so the plain web build is untouched.
 *
 * ## What this deliberately does NOT fix
 *
 * A flow that opens a window and then expects to talk to it — `window.opener`,
 * `postMessage`, or reading `.closed` — needs more than a URL handoff, because
 * the page now lives in a different browser process. `sdk/lib/mcp-oauth.ts`
 * solves that with a local-API relay and never reaches this shim (its adapter
 * short-circuits first). The AI-provider OAuth flow
 * (`settings/ai-providers/connect-provider-dialog.tsx`) still has the same
 * unsolved return channel and needs the same relay treatment; this shim gets
 * its consent screen on screen but cannot carry the token home.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { translate } from "@/i18n/use-t";

/** Schemes worth handing to the OS. */
const OPENABLE = /^(https?|vscode|cursor):/i;

/** Marks the global as already shimmed, so installing twice is harmless. */
const WINDOW_OPEN_SHIM_FLAG = "__decocmsWindowOpenShim__";

/**
 * A stand-in for the `Window` a browser would have returned.
 *
 * Callers commonly branch on a falsy return to report "popup blocked", so
 * handing back `null` after successfully opening the URL would surface a
 * failure that did not happen. The members are the ones call sites actually
 * touch; none of them can act on a page in another process, so they are inert
 * rather than pretending to control it.
 */
function openedWindowStub(): Window {
  return {
    closed: false,
    close() {},
    focus() {},
    blur() {},
    postMessage() {},
  } as unknown as Window;
}

/**
 * Replace `window.open` with one that hands the URL to the OS.
 *
 * Idempotent, and a no-op outside the Tauri webview.
 */
export function initializeDesktopWindowOpen(): void {
  if (typeof window === "undefined") return;
  if (!("__TAURI_INTERNALS__" in window)) return;
  if (WINDOW_OPEN_SHIM_FLAG in window) return;
  Object.defineProperty(window, WINDOW_OPEN_SHIM_FLAG, { value: true });

  const native = window.open.bind(window);

  window.open = ((
    url?: string | URL,
    target?: string,
    features?: string,
  ): Window | null => {
    const href = url?.toString() ?? "";
    // Anything this shim cannot route (`about:blank`, a bare fragment, an
    // empty call used to grab a handle) goes to the original, which keeps the
    // real browser's behaviour in the plain web build's code paths.
    if (!OPENABLE.test(href)) return native(url, target, features);

    openUrl(href).catch(() => {
      // Reaching the OS is the whole operation, so a failure has to be said
      // out loud — the click otherwise looks like it worked.
      toast.error(translate("common.openExternalFailed"));
    });
    return openedWindowStub();
  }) as typeof window.open;
}
