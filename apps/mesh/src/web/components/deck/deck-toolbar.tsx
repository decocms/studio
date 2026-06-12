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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
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
  File06,
  LayoutLeft,
  LinkExternal01,
  Printer,
  RefreshCw01,
} from "@untitledui/icons";
import { type ReactNode, useState } from "react";
import type { DeckEditor } from "./use-deck-editor";

export function DeckToolbar({
  readUrl,
  editor,
  downloadName,
  trailing,
}: {
  readUrl: string;
  editor: DeckEditor;
  /** Filename for the Download action (`download` attribute). */
  downloadName: string;
  /** Host-specific actions appended after the shared ones. */
  trailing?: ReactNode;
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
      <button
        type="button"
        onClick={() => window.open(absoluteUrl, "_blank", "noopener")}
        className="flex min-w-0 flex-1 items-center rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title={absoluteUrl}
      >
        <span className="truncate">{absoluteUrl}</span>
      </button>

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

      {editor.deckDetected ? (
        // One download control: a deck exports as PDF (print) or as the
        // raw HTML file. Plain pages get the simple download button below.
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Download">
              <Download01 size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => window.open(`${absoluteUrl}#print`, "_blank")}
            >
              <Printer size={14} />
              Export as PDF
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={absoluteUrl} download={downloadName}>
                <File06 size={14} />
                Download HTML
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Download" asChild>
              <a href={absoluteUrl} download={downloadName}>
                <Download01 size={14} />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Download</TooltipContent>
        </Tooltip>
      )}

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
      {trailing}
    </div>
  );
}
