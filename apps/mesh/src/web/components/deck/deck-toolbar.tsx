/**
 * DeckToolbar — header strip for the HtmlPreviewPanel: URL/copy/open
 * actions always; the slide-rail toggle, edit mode, and PDF export only
 * after the framed document completes the deck-viewer handshake
 * (editor.deckDetected) — a plain HTML preview shows none of them. Edit
 * mode additionally requires a writable source.
 *
 * PDF export opens the deck's read URL with a `#print` fragment in a new
 * tab: the deck-viewer runtime auto-triggers `window.print()` there and
 * its print CSS lays one slide per page, so the browser's Save-as-PDF
 * produces the export with zero server work.
 */

import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Check,
  Copy01,
  Download01,
  Edit03,
  LayoutLeft,
  LinkExternal01,
  RefreshCw01,
} from "@untitledui/icons";
import { useState } from "react";
import type { DeckEditor } from "./use-deck-editor";

export function DeckToolbar({
  readUrl,
  editor,
  variant = "full",
}: {
  readUrl: string;
  editor: DeckEditor;
  /** "controls" drops the URL row + copy/open (the host header has them). */
  variant?: "full" | "controls";
}) {
  const [copied, setCopied] = useState(false);
  const absoluteUrl = new URL(readUrl, window.location.origin).toString();

  const handleCopy = () => {
    navigator.clipboard.writeText(absoluteUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
      {editor.deckDetected && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={editor.railOpen ? "secondary" : "ghost"}
              size="icon"
              aria-label={
                editor.railOpen ? "Hide slide list" : "Show slide list"
              }
              onClick={() => editor.setRailOpen(!editor.railOpen)}
            >
              <LayoutLeft size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {editor.railOpen ? "Hide slide list" : "Show slide list"}
          </TooltipContent>
        </Tooltip>
      )}
      {variant === "full" ? (
        <button
          type="button"
          onClick={() => window.open(absoluteUrl, "_blank", "noopener")}
          className="flex min-w-0 flex-1 items-center rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={absoluteUrl}
        >
          <span className="truncate">{absoluteUrl}</span>
        </button>
      ) : (
        <div className="flex-1" />
      )}

      {editor.agentUpdated && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={editor.reload}
            >
              <RefreshCw01 size={12} />
              Agent updated — reload
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            The agent rewrote this deck while you were editing. Reloading
            discards unsaved differences.
          </TooltipContent>
        </Tooltip>
      )}

      {editor.saving && (
        <span className="px-1 text-xs text-muted-foreground">Saving…</span>
      )}

      {editor.deckDetected && editor.writable && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={editor.editMode ? "secondary" : "ghost"}
              size="icon"
              aria-label={editor.editMode ? "Done editing" : "Edit inline"}
              className={cn(editor.editMode && "text-primary")}
              onClick={() => editor.setEditMode(!editor.editMode)}
            >
              <Edit03 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {editor.editMode
              ? "Done editing"
              : "Edit inline (text, reorder, delete)"}
          </TooltipContent>
        </Tooltip>
      )}

      {editor.deckDetected && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Export PDF"
              onClick={() => window.open(`${absoluteUrl}#print`, "_blank")}
            >
              <Download01 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Export PDF (opens print dialog)
          </TooltipContent>
        </Tooltip>
      )}

      {variant === "full" && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Copy URL"
                onClick={handleCopy}
              >
                {copied ? <Check size={14} /> : <Copy01 size={14} />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {copied ? "Copied" : "Copy URL"}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Open in new tab"
                onClick={() => window.open(absoluteUrl, "_blank", "noopener")}
              >
                <LinkExternal01 size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Open in new tab</TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  );
}
