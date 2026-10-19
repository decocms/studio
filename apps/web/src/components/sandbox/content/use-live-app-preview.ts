import { useEffect, useRef, useState } from "react";
import { buildAppRenderRequest } from "@/components/sections-editor/section-preview-url";

const RENDER_DEBOUNCE_MS = 300;

type RenderRequest = { blockKey: string; src: string; body: string };

/**
 * Runs inside the preview frame. It POSTs each render from the frame's own
 * origin and swaps the document in place, so the page's same-origin assets
 * (fonts, stylesheets) load as they do on the site. A newer render aborts the
 * one in flight.
 */
const APP_PREVIEW_BRIDGE_SCRIPT = `(function() {
  if (window.__appPreviewBridge) return;
  window.__appPreviewBridge = true;
  var ctrl = null;
  window.addEventListener("message", function(e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.type !== "app-preview::render" || typeof d.src !== "string") return;
    if (new URL(d.src, location.href).origin !== location.origin) return;
    if (ctrl) ctrl.abort();
    var c = new AbortController();
    ctrl = c;
    fetch(d.src, {
      method: "POST",
      body: d.body,
      signal: c.signal,
      headers: { accept: "text/html", "content-type": "application/json" }
    }).then(function(res) {
      if (!res.ok) throw new Error("render " + res.status);
      return res.text();
    }).then(function(html) {
      if (c !== ctrl) return;
      document.documentElement.innerHTML = html;
      window.parent.postMessage({ type: "app-preview::render-end" }, "*");
    }).catch(function(err) {
      if (err && err.name === "AbortError") return;
      window.parent.postMessage({ type: "app-preview::render-error" }, "*");
    });
  });
  window.parent.postMessage({ type: "app-preview::ready" }, "*");
})();`;

function postRender(win: Window, origin: string, req: RenderRequest) {
  win.postMessage(
    { type: "app-preview::render", src: req.src, body: req.body },
    origin,
  );
}

/**
 * Re-renders an app's preview from the editor's unsaved decofile. The frame
 * shows the saved block (`src`) until the first edit; each edit is rendered
 * by a bridge script injected into the frame. On a frame without the bridge
 * listener the preview only follows saves.
 */
export function useLiveAppPreview(input: {
  previewBaseUrl: string | null;
  blockKey: string;
}) {
  const { blockKey } = input;
  const origin = input.previewBaseUrl
    ? new URL(input.previewBaseUrl).origin
    : null;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const latestRef = useRef<RenderRequest | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — subscribe to the frame's bridge messages; cancel the pending render on unmount
  useEffect(() => {
    if (!origin) return;
    const handler = (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (e.origin !== origin || !win || e.source !== win) return;
      const type = e.data?.type;
      if (type === "app-preview::ready") {
        // A reload (e.g. after a save) shows the saved block; reapply the latest edit.
        const req = latestRef.current;
        if (req?.blockKey === blockKey) postRender(win, origin, req);
      } else if (type === "app-preview::render-end") {
        setFailedKey(null);
      } else if (type === "app-preview::render-error") {
        setFailedKey(blockKey);
      }
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [origin, blockKey]);

  /** Activates the bridge via the daemon proxy's or the deco runtime's listener; its guard makes the second a no-op. */
  const onFrameLoad = () => {
    const win = frameRef.current?.contentWindow;
    if (!win || !origin) return;
    win.postMessage(
      { type: "visual-editor::activate", script: APP_PREVIEW_BRIDGE_SCRIPT },
      origin,
    );
    win.postMessage(
      { type: "editor::inject", args: { script: APP_PREVIEW_BRIDGE_SCRIPT } },
      origin,
    );
  };

  const render = (decofile: Record<string, unknown>) => {
    if (!input.previewBaseUrl || !origin) return;
    const { src, body } = buildAppRenderRequest({
      previewBaseUrl: input.previewBaseUrl,
      blockKey,
      decofile,
    });
    const req = { blockKey, src, body };
    latestRef.current = req;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const win = frameRef.current?.contentWindow;
      if (win) postRender(win, origin, req);
    }, RENDER_DEBOUNCE_MS);
  };

  return {
    frameRef,
    onFrameLoad,
    failed: failedKey === blockKey,
    render,
  };
}
