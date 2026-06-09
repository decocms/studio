import { useSyncExternalStore } from "react";

/**
 * Studio-itself PWA install.
 *
 * Per-org install works via the browser's native "Add to Home Screen" while
 * inside an org (see use-pwa-manifest.ts). But Studio always redirects "/" into
 * an org, so a logged-in user is never on a route where the generic "deco
 * Studio" manifest is active — there's no neutral page to install the app
 * itself from. The /install route (routes/install.tsx) is that neutral page:
 * it lives outside the org shell, so the static Studio manifest + apple-touch
 * defaults from index.html are active there.
 *
 * This module captures the Chromium `beforeinstallprompt` event as early as
 * possible (it fires once, shortly after load) so the install page can trigger
 * the native prompt on demand. iOS has no programmatic install — the page
 * falls back to "Share → Add to Home Screen" instructions there.
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

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const standaloneMedia =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  const iosStandalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standaloneMedia || iosStandalone;
}

export function isIos(): boolean {
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
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === "accepted") {
        deferredPrompt = null;
        emit();
      }
      return choice.outcome;
    },
  };
}
