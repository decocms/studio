import { derivePartsFromTiptapDoc } from "@/components/chat/derive-parts";
import { textFromParts } from "@/components/chat/queue-items";
import type { SendMessageParams } from "@/components/chat/store/types";
import type { Metadata } from "@/components/chat/types";

function isTiptapDoc(
  value: SendMessageParams | Metadata["tiptapDoc"],
): value is NonNullable<Metadata["tiptapDoc"]> {
  return (
    !!value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "doc" &&
    "content" in value &&
    Array.isArray(value.content)
  );
}

export interface TerminalPromptContent {
  text: string;
  hasUnsupportedAttachments: boolean;
}

export function promptContentFromParts(
  parts: ReadonlyArray<{ type?: string; text?: unknown }> | undefined,
): TerminalPromptContent {
  return {
    text: textFromParts(parts),
    hasUnsupportedAttachments: (parts ?? []).some(
      (part) => part.type !== "text",
    ),
  };
}

export function promptContentFromSendMessage(
  value: SendMessageParams | Metadata["tiptapDoc"],
): TerminalPromptContent {
  if (!value) return { text: "", hasUnsupportedAttachments: false };
  const parts = isTiptapDoc(value)
    ? derivePartsFromTiptapDoc(value)
    : (value.parts ?? derivePartsFromTiptapDoc(value.tiptapDoc));
  return promptContentFromParts(parts);
}

export function promptTextFromSendMessage(
  value: SendMessageParams | Metadata["tiptapDoc"],
): string {
  return promptContentFromSendMessage(value).text;
}

export function appendAppContexts(
  prompt: string,
  appContexts: Readonly<Record<string, string>>,
): string {
  const context = Object.entries(appContexts)
    .filter(([, text]) => text.trim())
    .map(([source, text]) => `### App Context: ${source}\n${text.trim()}`)
    .join("\n\n");
  return [prompt.trim(), context].filter(Boolean).join("\n\n");
}
