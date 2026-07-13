import { useSyncExternalStore } from "react";

/**
 * PWA install prompt capture.
 *
 * Studio ships a single static "deco Studio" manifest (index.html +
 * public/manifest.webmanifest) that stays active on every route. So the
 * browser's own "Add to Home Screen" / "Install" menu always installs Studio
 * itself — no JS required.
 *
 * Installing a single *org* as its own home-screen app is an explicit action:
 * the org install page (routes/org-install.tsx, at /:org/install) swaps the
 * document manifest to an org-branded one (see use-pwa-manifest.ts) and offers
 * an install button. This module captures the Chromium `beforeinstallprompt`
 * event as early as possible (it fires once, shortly after load) so that button
 * can trigger the native prompt on demand. iOS has no programmatic install —
 * the page falls back to "Share → Add to Home Screen" instructions there.
 *
 * The captured prompt is bound to whichever manifest was active when it fired,
 * so `clearPwaInstallPrompt()` drops it whenever the active manifest changes
 * (org manifest applied / restored) — the global listener then re-captures the
 * fresh prompt Chromium fires for the new manifest, so the button can never
 * install the wrong app.
 */

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let initialized = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Install the global event listeners. Must run eagerly at app startup (not
 * lazily from the install page) because `beforeinstallprompt` fires soon after
 * load and only once — a late listener would miss it.
 */
export function initPwaInstallCapture(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  window.addEventListener("beforeinstallprompt", (event) => {
    // Prevent Chrome's mini-infobar so we control when the prompt shows.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    emit();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    emit();
  });
}

/**
 * Drop any captured install prompt. Call when the active manifest changes so a
 * prompt bound to the previous manifest can't install the wrong app; the global
 * listener re-captures the prompt Chromium fires for the new manifest.
 */
export function clearPwaInstallPrompt(): void {
  if (deferredPrompt === null) return;
  deferredPrompt = null;
  emit();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function getSnapshot(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

function getServerSnapshot(): null {
  return null;
}

/**
 * True when the app is running as an installed PWA rather than a regular
 * browser tab. Covers the installed display modes this app uses (`standalone`
 * for mobile, `window-controls-overlay` for the desktop title-bar shell) plus
 * iOS's legacy `navigator.standalone`.
 *
 * We deliberately do NOT match `(display-mode: fullscreen)` or `minimal-ui`:
 * a plain browser tab can enter fullscreen (F11 / macOS fullscreen) without
 * being an installed PWA, which would give a false positive.
 */
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const displayModeMedia =
    typeof window.matchMedia === "function" &&
    [
      "(display-mode: standalone)",
      "(display-mode: window-controls-overlay)",
    ].some((query) => window.matchMedia(query).matches);
  const iosStandalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return displayModeMedia || iosStandalone;
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports a desktop "Macintosh" UA; touch support disambiguates.
  return (
    ua.includes("Macintosh") &&
    typeof document !== "undefined" &&
    "ontouchend" in document
  );
}

export type InstallOutcome = "accepted" | "dismissed" | "unavailable";

export interface PwaInstall {
  /** A native install prompt is available (Chromium) and the app isn't installed. */
  canPrompt: boolean;
  /** The app is already running as an installed PWA. */
  installed: boolean;
  /** Running on iOS, where install is manual via the Share sheet. */
  ios: boolean;
  /** Trigger the native install prompt. Resolves "unavailable" if none captured. */
  promptInstall: () => Promise<InstallOutcome>;
}

export function usePwaInstall(): PwaInstall {
  const prompt = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const installed = isStandalone();

  return {
    canPrompt: prompt !== null && !installed,
    installed,
    ios: isIos(),
    promptInstall: async () => {
      if (!deferredPrompt) return "unavailable";
      const promptEvent = deferredPrompt;
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      // The event fires only once — whether accepted or dismissed, it can't
      // be reused, so it must be dropped either way or the button would look
      // clickable but silently do nothing on a second try.
      deferredPrompt = null;
      emit();
      return choice.outcome;
    },
  };
}
