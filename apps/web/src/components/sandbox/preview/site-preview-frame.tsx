import { useEffect, useRef, useState, type RefObject } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { PreviewDeviceSize } from "./device-hint";
import {
  frameNavigationLoaded,
  HELD_NAVIGATION_RELEASE_MS,
  type HeldFrameNavigation,
  nextFrameNavigation,
} from "./frame-navigation";
import { resolvePreviewFrameGeometry } from "./preview-frame-geometry";
import { useIframeLoadRecovery } from "./preview-iframe-recovery";

/**
 * Reload the iframe in place; falls back to reassigning `src` when the
 * iframe's live location is cross-origin (sandbox preview domain) and
 * `.reload()` throws.
 */
export function reloadIframeOrFallback(
  iframe: HTMLIFrameElement,
  fallbackSrc: string | null,
) {
  try {
    iframe.contentWindow?.location.reload();
  } catch {
    if (fallbackSrc) iframe.src = fallbackSrc;
  }
}

/**
 * The site in an iframe, with the reload policy that keeps a dev server alive.
 *
 * Shared by the Site Editor's Preview and the Blog post editor so there is one
 * answer to "when does the frame reload". The short answer is: almost never on
 * its own. A sandbox session's saves are reloaded by the dev server's own HMR,
 * and asking for the page a second time on top of that is what makes the
 * daemon's `HEAD /` probe time out and kill the dev server. Fast Preview moves
 * the `?__draft=` version instead, so `src` changes and the frame navigates —
 * one navigation at a time when `holdNavigation` is set (frame-navigation.ts).
 *
 * The frame owns only the scaled surface. Overlays, toolbars, state cards and
 * anything injected into the page stay with the caller, which also owns the
 * canvas element this measures against.
 */
export function SitePreviewFrame({
  iframeRef,
  iframeBase,
  src,
  device,
  canvas,
  title,
  recoveryActive,
  draftUrl,
  holdNavigation = false,
  onNavigate,
  onLoad,
  onError,
  onMouseLeave,
}: {
  /** Owned by the caller, which postMessages into the frame. */
  iframeRef: RefObject<HTMLIFrameElement | null>;
  /**
   * Remount identity: the ORIGIN, not the page. Navigating within the site
   * must not drop the document — only a branch switch or a
   * production→sandbox swap gets a fresh frame.
   */
  iframeBase: string | null;
  src: string;
  device: PreviewDeviceSize;
  /** The container's measured size; `{0,0}` before the first measurement. */
  canvas: { width: number; height: number };
  title: string;
  /**
   * Retry loads that never arrive. Sandbox surface only — it must never
   * thrash the production fallback frame or the Fast Preview daemon frame,
   * which navigate cross-origin instead.
   */
  recoveryActive: boolean;
  /** Fast Preview's `?__draft=` URL, watched to force-navigate on a new version. */
  draftUrl?: string | null;
  /**
   * A Fast Preview frame: a new `src` waits for the current load instead of
   * cancelling it, and the latest one goes in after.
   */
  holdNavigation?: boolean;
  /** A forced navigation is starting, for the caller's progress indicator. */
  onNavigate?: () => void;
  onLoad?: () => void;
  onError?: () => void;
  onMouseLeave?: () => void;
}) {
  const geometry = resolvePreviewFrameGeometry({ device, canvas });
  const recovery = useIframeLoadRecovery({
    iframeRef,
    src: recoveryActive ? src : null,
    active: recoveryActive,
  });

  /**
   * Fast Preview refresh backstop: the daemon frame is cross-origin, so the
   * shared reload path cannot `.reload()` it. When the draft URL changes — a
   * page switch, or a new version after a save — force-navigate. The version
   * makes the URL distinct, and the ref guard makes the first paint (React
   * already set `src`) and unrelated re-renders no-ops.
   */
  const [navigation, setNavigation] = useState<HeldFrameNavigation>({
    src,
    loading: false,
  });
  const nextNavigation = nextFrameNavigation(navigation, src, holdNavigation);
  if (nextNavigation !== navigation) setNavigation(nextNavigation);
  const frameSrc = nextNavigation.src;
  const frameLoading = nextNavigation.loading;

  const lastDraftUrlRef = useRef<string | null>(null);
  // It navigates to the src the frame was given (`frameSrc`, held while a load
  // is on its way), and releases a held navigation whose load never fires, so
  // the next pointer still reaches the frame.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- imperative cross-origin iframe navigation on draft change; .reload() throws cross-origin
  useEffect(() => {
    const release = frameLoading
      ? setTimeout(
          () => setNavigation(frameNavigationLoaded),
          HELD_NAVIGATION_RELEASE_MS,
        )
      : null;
    const clear = () => {
      if (release) clearTimeout(release);
    };
    if (!draftUrl || !frameSrc) return clear;
    if (lastDraftUrlRef.current === draftUrl) return clear;
    lastDraftUrlRef.current = draftUrl;
    const iframe = iframeRef.current;
    if (iframe && iframe.getAttribute("src") !== frameSrc) {
      onNavigate?.();
      iframe.src = frameSrc;
    }
    return clear;
    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps -- the ref and the callback must not retrigger a navigation
  }, [draftUrl, frameSrc, frameLoading]);

  return (
    <div
      className={cn("shrink-0", !geometry.fluid && "bg-background shadow-edge")}
      style={geometry.style}
      onMouseLeave={onMouseLeave}
    >
      {/* TODO(security): this frame has no sandbox. It loads the user's own dev
          server cross-origin and the editor drives it (navigation, hover,
          postMessage), so picking the token set is a change that needs the real
          sandbox running to verify — a missing token silently breaks a
          customer's site preview. Deliberately not bolted on during a lint
          sweep. */}
      {/* oxlint-disable-next-line react/iframe-missing-sandbox */}
      <iframe
        key={iframeBase}
        ref={iframeRef}
        src={frameSrc}
        className="w-full h-full border-0"
        title={title}
        onError={() => {
          recovery.handleError();
          onError?.();
        }}
        onLoad={() => {
          // A held navigation may go in now.
          setNavigation(frameNavigationLoaded);
          recovery.handleLoad();
          onLoad?.();
        }}
      />
    </div>
  );
}
