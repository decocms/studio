import { cn } from "@deco/ui/lib/utils.ts";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { type UIMessage } from "ai";
import { useRef, useState } from "react";
import { FileNode } from "../tiptap/file/node.tsx";
import { MentionNode } from "../tiptap/mention/node.tsx";
import { SecretRefNode } from "../tiptap/secret-ref/node.tsx";
import type { Metadata } from "../types.ts";
import { MessageTextPart } from "./parts/text-part.tsx";
import { MessageTimestamp } from "./timestamp.tsx";
import {
  type TriggerEventData,
  TriggerEventPart,
} from "./parts/trigger-event-part.tsx";

export interface MessageProps<T extends Metadata> {
  message: UIMessage<T>;
  className?: string;
  onScrollToPair?: () => void;
}

const EXTENSIONS = [
  StarterKit.configure({
    heading: false,
    blockquote: false,
    codeBlock: false,
    horizontalRule: false,
  }),
  MentionNode,
  FileNode,
  SecretRefNode,
];

/**
 * Read-only Tiptap renderer for rich message content
 */
function RichMessageContent({
  tiptapDoc,
}: {
  tiptapDoc: Metadata["tiptapDoc"];
}) {
  const editor = useEditor({
    extensions: EXTENSIONS,
    content: tiptapDoc,
    editable: false,
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none focus:outline-none",
      },
    },
  });

  if (!editor) return null;

  return (
    <EditorContent
      editor={editor}
      className="[&_.ProseMirror]:outline-none [&_.ProseMirror]:cursor-text"
    />
  );
}

export function MessageUser<T extends Metadata>({
  message,
  className,
  onScrollToPair,
}: MessageProps<T>) {
  const { id, parts, metadata } = message;
  const [isFocused, setIsFocused] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const overflowChecked = useRef(false);

  const setContentRef = (node: HTMLDivElement | null) => {
    if (node && !overflowChecked.current) {
      overflowChecked.current = true;
      setIsOverflowing(node.scrollHeight > node.clientHeight);
    }
  };

  // Early return if no parts
  if (!parts || parts.length === 0) {
    return null;
  }

  const handleClick = () => {
    setIsFocused(true);
    onScrollToPair?.();
  };

  // Check if we have rich content to render
  const hasTiptapDoc = metadata?.tiptapDoc;

  return (
    <>
      <div
        className={cn(
          "message-block w-full min-w-0 relative flex items-start gap-4 px-2.5 text-foreground flex-row-reverse",
          className,
        )}
      >
        <div className="w-full min-w-0 flex flex-col">
          <div
            tabIndex={0}
            onClick={handleClick}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            className="w-full border border-border/60 min-w-0 shadow-xs rounded-lg text-[14px] wrap-break-word overflow-wrap-anywhere bg-background cursor-pointer transition-colors relative flex outline-none"
          >
            <div className="absolute inset-0 bg-muted/75 rounded-lg pointer-events-none" />
            <div
              ref={setContentRef}
              className={cn(
                "z-10 px-4 py-2 flex-1 transition-[max-height,opacity] duration-300 ease-out",
                isFocused
                  ? "max-h-[50vh] overflow-auto opacity-100"
                  : cn(
                      "max-h-[84px] overflow-hidden opacity-99",
                      isOverflowing && "mask-b-from-1%",
                    ),
              )}
            >
              <div className="flex flex-col gap-2">
                {/* Trigger-event cards always render from `parts`, even when the
                  message also carries a tiptapDoc (automation runs do). */}
                {parts.map((part, index) =>
                  part.type === "data-trigger-event" ? (
                    <TriggerEventPart
                      key={`${id}-${index}`}
                      event={(part as { data: TriggerEventData }).data}
                    />
                  ) : null,
                )}
                {hasTiptapDoc ? (
                  <RichMessageContent tiptapDoc={metadata.tiptapDoc} />
                ) : (
                  parts.map((part, index) => {
                    if (part.type === "text") {
                      // The guard-wrapped event text the model reads sits
                      // directly after its `data-trigger-event` card — render the
                      // card, not the raw JSON. The automation's own instruction
                      // text (no card before it) still renders.
                      if (parts[index - 1]?.type === "data-trigger-event") {
                        return null;
                      }
                      return (
                        <MessageTextPart
                          key={`${id}-${index}`}
                          id={id}
                          part={part}
                          redactRaw
                        />
                      );
                    }
                    return null;
                  })
                )}
              </div>
            </div>
          </div>
          <MessageTimestamp message={message} className="mt-1 mr-1 self-end" />
        </div>
      </div>
    </>
  );
}
