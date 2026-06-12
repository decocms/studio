/**
 * HtmlPreviewPanel — the ONE side-panel surface for previewing generated
 * HTML, shared by the deck tab (org-fs files) and the legacy web-page tab
 * (`pages/` object-storage mirrors).
 *
 * It always renders a sandboxed iframe of the given URL. If the framed
 * document speaks the deck-viewer protocol (posts `ready`), the panel
 * upgrades itself: the toolbar grows the slide-rail toggle and PDF
 * export, and — when a `savePath` makes the source writable — the inline
 * edit mode with op save-back. A plain HTML page never handshakes and
 * stays a passive preview with copy/open actions.
 *
 * `marker` keys the iframe src (cache-bust); when it changes the editor
 * hook decides whether to reload (suppressed mid-edit — see
 * use-deck-editor.ts).
 */

import { cn } from "@deco/ui/lib/utils.ts";
import { useState } from "react";
import { DeckToolbar } from "./deck-toolbar";
import { useDeckEditor } from "./use-deck-editor";

const FADE_MS = 300;

export function HtmlPreviewPanel({
  readUrl,
  marker,
  title,
  savePath,
  chrome = "full",
}: {
  readUrl: string;
  /** Content marker (org-fs `size-updatedAt` / publish byte count). */
  marker: string;
  title: string;
  /** Org-fs home-volume path for edit save-back; omit = read-only. */
  savePath?: string;
  /** "full" = own toolbar with URL/copy/open. "controls" = the host
   *  already has a header (e.g. the Library preview) — render only the
   *  deck controls, and only once the handshake upgrades the panel. */
  chrome?: "full" | "controls";
}) {
  const editor = useDeckEditor({ readUrl, statMarker: marker, savePath });

  // Fade the iframe in per loaded document; reset when the src rolls.
  const [readySrc, setReadySrc] = useState<string | null>(null);

  if (editor.displayedMarker === null) return null;

  // Hash carries the runtime's view state (`#rail` opens the thumbnail
  // rail) — kept out of the iframe `key` so toggling it is a fragment
  // navigation inside the existing document, not a reload.
  const sep = readUrl.includes("?") ? "&" : "?";
  const baseSrc = `${readUrl}${sep}v=${encodeURIComponent(editor.displayedMarker)}`;
  const src = editor.railOpen ? `${baseSrc}#rail` : baseSrc;
  const iframeReady = readySrc === baseSrc;

  const showToolbar = chrome === "full" || editor.deckDetected;
  return (
    <div className="flex h-full w-full flex-col bg-background">
      {showToolbar && (
        <DeckToolbar readUrl={readUrl} editor={editor} variant={chrome} />
      )}
      <div className="relative flex-1">
        <iframe
          key={baseSrc}
          ref={editor.iframeRef}
          src={src}
          onLoad={() => setReadySrc(baseSrc)}
          sandbox="allow-scripts"
          className={cn(
            "absolute inset-0 block h-full w-full bg-white",
            "transition-opacity ease-out",
            iframeReady ? "opacity-100" : "opacity-0",
          )}
          style={{ transitionDuration: `${FADE_MS}ms` }}
          title={title}
        />
      </div>
    </div>
  );
}
