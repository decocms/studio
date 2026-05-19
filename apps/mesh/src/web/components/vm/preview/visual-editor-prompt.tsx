import { useRef, useState } from "react";
import { useChatStream } from "@/web/components/chat/context";
import { usePanelActions } from "@/web/layouts/shell-layout";
import type { VisualEditorPayload } from "./visual-editor-script";

/** Sanitize a string for safe embedding in markdown (escape backticks and asterisks) */
function sanitizeMd(s: string): string {
  return s.replace(/[`*_]/g, "\\$&");
}

/**
 * Build the markdown message sent to the AI from a visual editor click.
 * Exported for testing.
 */
export function formatVisualEditorMessage(
  payload: VisualEditorPayload,
  prompt: string,
): string {
  const lines = [
    `The user selected an element on the live preview and asked: **"${sanitizeMd(prompt.trim())}"**`,
    "",
    "For text content changes, locate the correct source file and apply the change.",
    "For code and CSS changes, understand which component the user is referring to and apply changes to the correct component.",
    "",
  ];

  if (payload.manifestKey) {
    lines.push(
      `**Section source file:** \`${sanitizeMd(payload.manifestKey)}\``,
      "",
    );
  }

  const selector = `<${payload.tag}${payload.classes ? ` class="${sanitizeMd(payload.classes)}"` : ""}>`;
  lines.push(`**Clicked element:** \`${selector}\``);
  if (payload.parents)
    lines.push(
      `**DOM breadcrumb:** ${sanitizeMd(payload.parents)} > ${payload.tag}`,
    );
  if (payload.text)
    lines.push(`**Text content:** "${sanitizeMd(payload.text)}"`);
  if (payload.componentName)
    lines.push(`**Component name:** ${sanitizeMd(payload.componentName)}`);

  // Escape triple-backticks in html to prevent markdown code fence breakout
  const safeHtml = payload.html.replace(/```/g, "`` `");
  lines.push("", "**HTML snippet:**", "```html", safeHtml, "```");
  lines.push(
    "",
    "Please read the source file, locate the element, and apply the requested change.",
  );

  return lines.join("\n");
}

/**
 * Compute the floating prompt position relative to the clicked element.
 * Returns { leftPct, topPct } as percentages of viewport.
 * Exported for testing.
 */
export function computePromptPosition(
  position: { x: number; y: number },
  viewport: { width: number; height: number },
  popupW = 320,
  popupH = 44,
  pad = 12,
): { leftPct: number; topPct: number } {
  const { x, y } = position;
  const { width: vw, height: vh } = viewport;
  const left = Math.max(pad, Math.min(x - popupW / 2, vw - popupW - pad));
  const isNearBottom = y / vh > 0.68;
  const top = isNearBottom
    ? Math.max(pad, y - popupH - 18)
    : Math.min(y + 18, vh - popupH - pad);

  return {
    leftPct: (left / vw) * 100,
    topPct: (top / vh) * 100,
  };
}

interface VisualEditorPromptProps {
  element: VisualEditorPayload;
  onDismiss: () => void;
}

export function VisualEditorPrompt({
  element,
  onDismiss,
}: VisualEditorPromptProps) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { sendMessage } = useChatStream();
  const { setChatOpen } = usePanelActions();

  const handleSend = () => {
    if (!input.trim()) return;

    const text = formatVisualEditorMessage(element, input);
    setChatOpen(true);
    sendMessage({ parts: [{ type: "text", text }] });
    onDismiss();
  };

  const pos = computePromptPosition(element.position, element.viewport);

  return (
    <div
      className="absolute z-30 pointer-events-none"
      style={{
        left: `${pos.leftPct}%`,
        top: `${pos.topPct}%`,
        width: "320px",
      }}
    >
      <form
        className="pointer-events-auto flex w-full items-center gap-1.5 rounded-xl border border-border bg-background/95 px-3 py-1.5 shadow-lg backdrop-blur"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
      >
        <input
          ref={inputRef}
          autoFocus
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onDismiss();
          }}
          placeholder="Ask the AI..."
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <button
          type="submit"
          disabled={!input.trim()}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity disabled:opacity-30"
          title="Send"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden="true"
          >
            <title>Send</title>
            <path
              d="M5 9V1M1 5l4-4 4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </form>
    </div>
  );
}
