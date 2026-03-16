"use client";

import { useRef } from "react";

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming,
  disabled,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isStreaming && value.trim()) {
        onSubmit();
      }
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    // Auto-resize
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  };

  return (
    <div className="relative flex items-end gap-2 rounded-2xl border border-border bg-card px-4 py-3 shadow-sm focus-within:ring-2 focus-within:ring-ring/20 focus-within:border-ring/40 transition-all">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        placeholder="Describe the feature you'd like..."
        disabled={disabled}
        rows={1}
        className="flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50 min-h-[24px] max-h-[200px]"
      />
      {isStreaming ? (
        <button
          type="button"
          onClick={onStop}
          className="shrink-0 flex items-center justify-center size-8 rounded-full bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
          title="Stop generating"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
            <rect x="2" y="2" width="10" height="10" rx="1.5" />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          onClick={onSubmit}
          disabled={!value.trim() || disabled}
          className="shrink-0 flex items-center justify-center size-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Send message"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8 12V4M4 8l4-4 4 4" />
          </svg>
        </button>
      )}
    </div>
  );
}
