import { CornerDownRight } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { useChatPrefs, useChatStream } from "./context";
import { useAgentSuggestions } from "@/web/hooks/use-agent-suggestions";
import type { TiptapDoc } from "./types";

// ── UI ─────────────────────────────────────────────────────────────────────

interface ThreadSuggestionsProps {
  suggestions: string[];
  onSelect: (text: string) => void;
  disabled?: boolean;
  className?: string;
}

export function ThreadSuggestions({
  suggestions,
  onSelect,
  disabled,
  className,
}: ThreadSuggestionsProps) {
  if (suggestions.length === 0) return null;

  return (
    <div className={cn("flex flex-col items-start gap-2", className)}>
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(suggestion)}
          className={cn(
            "flex items-center gap-2 px-4 py-2.5 rounded-full",
            "bg-muted text-muted-foreground text-sm font-medium",
            "transition-colors hover:bg-muted/70 hover:text-foreground",
            disabled && "opacity-50 cursor-not-allowed",
          )}
        >
          <CornerDownRight size={14} className="shrink-0" />
          <span>{suggestion}</span>
        </button>
      ))}
    </div>
  );
}

// ── After-message container ────────────────────────────────────────────────

function useSuggestionSend() {
  const { sendMessage, isStreaming } = useChatStream();

  const send = async (text: string) => {
    const doc: TiptapDoc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    };
    await sendMessage(doc);
  };

  return { send, disabled: isStreaming };
}

export function AfterMessageSuggestions({ className }: { className?: string }) {
  const { selectedVirtualMcp } = useChatPrefs();
  const { send, disabled } = useSuggestionSend();
  const suggestions = useAgentSuggestions(selectedVirtualMcp?.id);

  if (suggestions.length === 0) return null;

  return (
    <ThreadSuggestions
      suggestions={suggestions}
      onSelect={send}
      disabled={disabled}
      className={className}
    />
  );
}
