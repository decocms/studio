import { useEffect, useRef, useState } from "react";
import { XClose } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { MonacoCodeEditor } from "@/web/components/monaco-editor";

/** Debounce before persisting valid JSON edits. */
const JSON_APPLY_DEBOUNCE_MS = 700;

/** Curly-braces glyph (lucide "braces") — a real `{ }`, unlike the square brackets icon. */
export function CurlyBracesIcon({
  size = 14,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M7 4a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2" />
      <path d="M17 4a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2" />
    </svg>
  );
}

/**
 * Editable JSON view of a saved global block, backed by Monaco. Seeds from the
 * block's current data on mount (re-mount per block via `key`); valid edits are
 * persisted via `onApply` — debounced while typing, immediately on Cmd/Ctrl+S.
 * Saved blocks only: raw/unsaved sections don't have a persisted block to edit.
 */
export function SectionJsonPanel({
  blockKey,
  data,
  onApply,
  onClose,
}: {
  blockKey: string;
  data: unknown;
  onApply: (data: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  // Seed once on mount — re-seeding on `data` changes (e.g. after our own save)
  // would fight the editor's cursor. The call site remounts this per block.
  const [draft] = useState(() => JSON.stringify(data ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — timer lifecycle cleanup
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const apply = (value: string) => {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError("JSON must be an object.");
        return;
      }
      setError(null);
      onApply(parsed as Record<string, unknown>);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid JSON.");
    }
  };

  const handleChange = (value: string | undefined) => {
    const next = value ?? "";
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => apply(next), JSON_APPLY_DEBOUNCE_MS);
  };

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <CurlyBracesIcon
          size={13}
          className="ml-1 shrink-0 text-muted-foreground"
        />
        <span className="flex-1 truncate pl-1 text-xs font-medium text-muted-foreground">
          {blockKey} JSON
        </span>
        {error && (
          <span className="truncate text-xs text-destructive" title={error}>
            Invalid JSON
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onClose}
              aria-label="Close JSON editor"
            >
              <XClose size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Close</TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1">
        <MonacoCodeEditor
          code={draft}
          language="json"
          height="100%"
          onChange={handleChange}
          onSave={(value) => apply(value)}
        />
      </div>
    </div>
  );
}
