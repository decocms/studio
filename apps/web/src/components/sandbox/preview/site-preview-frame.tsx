import { useEffect, useRef, useState, type RefObject } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { PreviewDeviceSize } from "./device-hint";
import {
  frameNavigationLoaded,
  HELD_NAVIGATION_RELEASE_MS,
  heldForChange,
  type HeldFrameNavigation,
  nextFrameNavigation,
} from "./frame-navigation";
import { resolvePreviewFrameGeometry } from "./preview-frame-geometry";
import { useIframeLoadRecovery } from "./preview-iframe-recovery";
import { PreviewProgressBar } from "./preview-progress-bar";

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
 * The site in an iframe, for the Blog post preview, with the Site Editor
 * preview's reload policy: almost never reload on its own. A sandbox session's
 * saves are reloaded by the dev server's own HMR, and asking for the page a
 * second time on top of that is what makes the daemon's `HEAD /` probe time
 * out and kill the dev server. Fast Preview moves the `?__draft=` version
 * instead, so `src` changes and the frame navigates — one navigation at a time
 * when `holdNavigation` is set (frame-navigation.ts, shared with the Site
 * Editor's preview).
 *
 * The Site Editor's progress bar shows while a change is on its way: from the
 * start of the caller's save to the frame's next load (the reload or
 * navigation that shows it), and while any load the frame was given runs.
 *
 * The frame owns only the scaled surface and that bar. Toolbars and state
 * cards stay with the caller, which also owns the canvas element this
 * measures against (and the bar sits on: it must be `relative`).
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
  changePending = false,
  expectLoad = 0,
}: {
  /** Owned by the caller, which reloads the frame. */
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
  /**
   * A content change is saving (content-sync.ts). It reaches the page with
   * the frame's next load, and a move to another page waits for it to land
   * ({@link heldForChange}).
   */
  changePending?: boolean;
  /** Bumped when the caller reloads the frame: the bar shows until it loads. */
  expectLoad?: number;
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
  const nextNavigation = nextFrameNavigation(
    navigation,
    heldForChange(navigation.src, src, changePending),
    holdNavigation,
  );
  if (nextNavigation !== navigation) setNavigation(nextNavigation);
  const frameSrc = nextNavigation.src;
  const frameLoading = nextNavigation.loading;

  /**
   * Waiting for a load that shows something new: the first one, a new src, a
   * reload the caller asked for, or — from the moment a change starts saving
   * — the reload or navigation that brings it in, even if that lands before
   * the save's own refresh ends.
   */
  const [awaitingLoad, setAwaitingLoad] = useState(true);
  const [seen, setSeen] = useState({ frameSrc, changePending, expectLoad });
  if (
    seen.frameSrc !== frameSrc ||
    seen.changePending !== changePending ||
    seen.expectLoad !== expectLoad
  ) {
    setSeen({ frameSrc, changePending, expectLoad });
    const changeStarted = changePending && !seen.changePending;
    if (
      seen.frameSrc !== frameSrc ||
      seen.expectLoad !== expectLoad ||
      changeStarted
    ) {
      setAwaitingLoad(true);
    }
  }

  const lastDraftUrlRef = useRef<string | null>(null);
  // It navigates to the src the frame was given (`frameSrc`, held while a load
  // is on its way), and releases a held navigation, or a wait for a load,
  // whose load never fires, so the next pointer still reaches the frame and
  // the bar doesn't stay up for good.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- imperative cross-origin iframe navigation on draft change; .reload() throws cross-origin
  useEffect(() => {
    const release =
      frameLoading || awaitingLoad
        ? setTimeout(() => {
            setNavigation(frameNavigationLoaded);
            setAwaitingLoad(false);
          }, HELD_NAVIGATION_RELEASE_MS)
        : null;
    const clear = () => {
      if (release) clearTimeout(release);
    };
    if (!draftUrl || !frameSrc) return clear;
    if (lastDraftUrlRef.current === draftUrl) return clear;
    lastDraftUrlRef.current = draftUrl;
    const iframe = iframeRef.current;
    if (iframe && iframe.getAttribute("src") !== frameSrc) {
      iframe.src = frameSrc;
    }
    return clear;
    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps -- the ref must not retrigger a navigation
  }, [draftUrl, frameSrc, frameLoading, awaitingLoad]);

  return (
    <>
      {(changePending || awaitingLoad || frameLoading) && (
        <PreviewProgressBar />
      )}
      <div
        className={cn(
          "shrink-0",
          !geometry.fluid && "bg-background shadow-edge",
        )}
        style={geometry.style}
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
          onError={recovery.handleError}
          onLoad={() => {
            // A held navigation may go in now, and what was awaited is shown.
            setNavigation(frameNavigationLoaded);
            setAwaitingLoad(false);
            recovery.handleLoad();
          }}
        />
      </div>
    </>
  );
}
