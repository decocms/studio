"use client";

import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Code01, Expand06, XClose } from "@untitledui/icons";
import type { ToolUIPart } from "ai";
import { useRef, useState, useEffect } from "react";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";

interface RenderHtmlInput {
  html?: string;
  title?: string;
}

interface RenderHtmlOutput {
  html?: string;
}

interface RenderHtmlPartProps {
  part: ToolUIPart;
}

/**
 * Script injected into the iframe to auto-resize its height based on content
 * and communicate it to the parent via postMessage.
 */
const AUTO_RESIZE_SCRIPT = `
<script>
(function() {
  function sendHeight() {
    var h = document.documentElement.scrollHeight;
    window.parent.postMessage({ type: 'iframe-resize', height: h }, '*');
  }
  window.addEventListener('load', sendHeight);
  new ResizeObserver(sendHeight).observe(document.documentElement);
  sendHeight();
})();
</script>`;

export function RenderHtmlPart({ part }: RenderHtmlPartProps) {
  const state = getEffectiveState(part.state);
  const input = part.input as RenderHtmlInput | undefined;
  const output = part.output as RenderHtmlOutput | undefined;
  const title = input?.title ?? "HTML Preview";
  const html = output?.html ?? input?.html;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(200);
  const [expanded, setExpanded] = useState(false);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (
        event.data?.type === "iframe-resize" &&
        typeof event.data.height === "number" &&
        iframeRef.current &&
        event.source === iframeRef.current.contentWindow
      ) {
        setIframeHeight(Math.min(event.data.height, 800));
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  if (state === "loading") {
    return (
      <ToolCallShell
        icon={<Code01 size={14} />}
        title={`Rendering ${title}`}
        state="loading"
      />
    );
  }

  if (state === "error" || !html) {
    return (
      <ToolCallShell
        icon={<Code01 size={14} />}
        title={title}
        summary={state === "error" ? "Failed" : "No HTML content"}
        state={state === "error" ? "error" : "idle"}
      />
    );
  }

  // Inject auto-resize script into the HTML
  const srcDoc = html.includes("</body>")
    ? html.replace("</body>", `${AUTO_RESIZE_SCRIPT}</body>`)
    : html + AUTO_RESIZE_SCRIPT;

  return (
    <div className="flex flex-col gap-2">
      <ToolCallShell
        icon={<Code01 size={14} className="text-blue-500" />}
        title={title}
        state="idle"
      />
      <div className="relative group/html-preview">
        <iframe
          ref={iframeRef}
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          className="w-full rounded-lg border border-border"
          style={{ height: iframeHeight, minHeight: 100 }}
          title={title}
        />
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="absolute top-2 right-2 flex items-center justify-center size-7 rounded-md bg-black/50 text-white opacity-0 group-hover/html-preview:opacity-100 transition-opacity backdrop-blur-sm"
          aria-label="Expand preview"
        >
          <Expand06 size={14} />
        </button>
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogPortal>
          <DialogOverlay />
          <DialogPrimitive.Content className="fixed inset-4 z-50 flex flex-col rounded-xl bg-background shadow-2xl focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <DialogTitle className="text-sm font-medium">{title}</DialogTitle>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="flex items-center justify-center size-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                aria-label="Close preview"
              >
                <XClose size={18} />
              </button>
            </div>
            <div className="flex-1 min-h-0 p-2">
              <iframe
                srcDoc={srcDoc}
                sandbox="allow-scripts"
                className="w-full h-full rounded-lg border border-border"
                title={title}
              />
            </div>
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    </div>
  );
}
