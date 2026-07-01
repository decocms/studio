import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ArrowUp, Loading01, RefreshCw01 } from "@untitledui/icons";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  PROMPT_EXPLORER_MIN_CHARS,
  usePromptEnricher,
} from "@/web/hooks/use-prompt-enricher.ts";

interface PromptExplorerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Seed the editor with the user's current composer draft. */
  initialText?: string;
  /** Called with the current prompt when the user clicks Send. */
  onSend: (text: string) => void;
}

interface Version {
  id: number;
  text: string;
}

export function PromptExplorerDialog({
  open,
  onOpenChange,
  initialText,
  onSend,
}: PromptExplorerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[1100px] w-[95vw] h-[85svh] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-5 py-3 border-b border-border shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <RefreshCw01 size={18} />
            Improve prompt
          </DialogTitle>
          <DialogDescription className="sr-only">
            Improve a rough idea into a richer, more detailed, ready-to-use
            prompt, then send it to the chat.
          </DialogDescription>
        </DialogHeader>
        {/* Radix unmounts content on close, so the body remounts fresh each
            open — local state (versions, selection) resets naturally. */}
        {open && (
          <PromptExplorerBody
            initialText={initialText}
            onSend={(text) => {
              onSend(text);
              onOpenChange(false);
            }}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PromptExplorerBody({
  initialText,
  onSend,
  onClose,
}: {
  initialText?: string;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<Version[]>(() => [
    { id: 0, text: initialText ?? "" },
  ]);
  const [selectedId, setSelectedId] = useState(0);
  const [streamingId, setStreamingId] = useState<number | null>(null);
  const nextId = useRef(1);
  const enricher = usePromptEnricher();

  const selected =
    versions.find((v) => v.id === selectedId) ?? versions[versions.length - 1]!;
  const isStreaming = enricher.status === "streaming";
  const isStreamingSelected = isStreaming && streamingId === selectedId;
  // While the selected version is streaming, show the live text; otherwise the
  // committed version text (which the user can edit directly).
  const mainValue = isStreamingSelected ? enricher.text : selected.text;
  const trimmedLen = selected.text.trim().length;
  const canImprove = !isStreaming && trimmedLen >= PROMPT_EXPLORER_MIN_CHARS;
  const canSend = !isStreaming && trimmedLen > 0;

  const updateSelected = (text: string) => {
    setVersions((vs) =>
      vs.map((v) => (v.id === selectedId ? { ...v, text } : v)),
    );
  };

  const handleImprove = async () => {
    if (!canImprove) return;
    const source = selected.text;
    const id = nextId.current++;
    // The new (soon-to-be-improved) version becomes the latest and is selected
    // immediately; the source version stays in the sidebar.
    setVersions((vs) => [...vs, { id, text: "" }]);
    setSelectedId(id);
    setStreamingId(id);
    try {
      const result = await enricher.enrich(source);
      setVersions((vs) =>
        vs.map((v) => (v.id === id ? { ...v, text: result.text } : v)),
      );
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to improve the prompt",
      );
      // Drop the empty placeholder version and return to the source.
      setVersions((vs) => vs.filter((v) => v.id !== id));
      setSelectedId(selected.id);
    } finally {
      setStreamingId(null);
    }
  };

  const handleSend = () => {
    if (!canSend) return;
    onSend(selected.text);
  };

  // Enter → Improve, Cmd/Ctrl+Enter → Send, Shift+Enter → newline.
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) {
      handleSend();
    } else {
      void handleImprove();
    }
  };

  const handleClose = () => {
    enricher.cancel();
    onClose();
  };

  // Auto-run the first improvement on open when the composer draft already has
  // enough text — opening Improve "just starts improving". A mount-scoped
  // effect is the natural fit here (mirrors useSubtaskStream in this codebase);
  // the ref guards against StrictMode's double-invoke.
  const didAutoRun = useRef(false);
  /* oxlint-disable ban-use-effect/ban-use-effect */
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (didAutoRun.current) return;
    didAutoRun.current = true;
    if ((initialText ?? "").trim().length >= PROMPT_EXPLORER_MIN_CHARS) {
      void handleImprove();
    }
  }, []);
  /* oxlint-enable react-hooks/exhaustive-deps */
  /* oxlint-enable ban-use-effect/ban-use-effect */

  const placeholder =
    isStreamingSelected && !enricher.text
      ? "Thinking…"
      : versions.length === 1
        ? "Write a rough idea for your prompt, then click Improve to expand it."
        : "Edit this version, Improve again to expand it further, or Send.";

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 flex">
        {/* Versions sidebar */}
        <aside className="w-56 shrink-0 border-r border-border flex flex-col min-h-0">
          <div className="px-3 pt-3 pb-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Versions
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1">
            {versions.map((v, i) => {
              const isLatest = i === versions.length - 1;
              const active = v.id === selectedId;
              const streamingThis = streamingId === v.id;
              const label = i === 0 ? "Original idea" : `Version ${i}`;
              const preview = (streamingThis ? enricher.text : v.text).trim();
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => !isStreaming && setSelectedId(v.id)}
                  disabled={isStreaming}
                  className={cn(
                    "w-full text-left rounded-lg px-2.5 py-2 transition-colors border",
                    active
                      ? "bg-muted border-border"
                      : "border-transparent hover:bg-muted/60",
                    isStreaming && !streamingThis && "opacity-60",
                  )}
                >
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <span
                      className={cn(
                        active ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {label}
                    </span>
                    {isLatest && !streamingThis && (
                      <span className="text-[10px] font-medium text-muted-foreground rounded bg-muted-foreground/10 px-1 py-px">
                        Latest
                      </span>
                    )}
                    {streamingThis && (
                      <Loading01
                        size={11}
                        className="animate-spin text-foreground"
                      />
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                    {preview || "Empty"}
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Main editor */}
        <div className="flex-1 min-h-0 flex flex-col">
          {enricher.reasoning && isStreamingSelected && (
            <div className="mx-5 mt-3 max-h-24 overflow-y-auto rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap">
              {enricher.reasoning}
            </div>
          )}
          <Textarea
            autoFocus
            value={mainValue}
            onChange={(e) => updateSelected(e.target.value)}
            onKeyDown={handleKeyDown}
            readOnly={isStreamingSelected}
            placeholder={placeholder}
            className="flex-1 min-h-0 resize-none border-0 rounded-none bg-transparent focus-visible:ring-0 px-5 py-4 text-sm leading-relaxed shadow-none"
          />
        </div>
      </div>

      {/* Footer actions */}
      <div className="border-t border-border px-5 py-3 flex items-center justify-between gap-3 shrink-0">
        <div className="text-xs text-muted-foreground min-w-0 truncate">
          {isStreaming
            ? "Improving your prompt…"
            : trimmedLen < PROMPT_EXPLORER_MIN_CHARS
              ? `Write at least ${PROMPT_EXPLORER_MIN_CHARS} characters, then Improve.`
              : versions.length === 1
                ? "Click Improve to expand it into a complete prompt."
                : "Edit, Improve again, or Send when you're happy."}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button type="button" variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleImprove}
            disabled={!canImprove}
            title="Improve and expand this prompt (Enter)"
          >
            <RefreshCw01
              size={16}
              className={cn(isStreaming && "animate-spin")}
            />
            Improve
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleSend}
            disabled={!canSend}
            title="Send this prompt to the chat (⌘/Ctrl+Enter)"
          >
            <ArrowUp size={16} />
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
