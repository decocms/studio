/**
 * Shared utilities for converting Tiptap documents to chat message parts.
 * Used by both the chat context (for sending messages) and the automation
 * detail page (for persisting messages).
 */

import type {
  PromptMessage,
  ReadResourceResult,
  EmbeddedResource,
} from "@modelcontextprotocol/sdk/types.js";
import type { FileAttrs } from "./tiptap/file/node.tsx";
import type { ChatMessage, Metadata } from "./types.ts";

/**
 * Converts file attributes to UI message parts
 * Text files are decoded and returned as text parts, others as file parts
 */
function fileAttrsToParts(
  fileAttrs: FileAttrs,
  mentionName: string,
): ChatMessage["parts"] {
  const { mimeType, data } = fileAttrs;

  // Text files: decode base64 and return as text part
  if (mimeType.startsWith("text/")) {
    try {
      const decodedText = new TextDecoder().decode(
        Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
      );
      return [
        {
          type: "text",
          text: `${mentionName}\n${decodedText}`,
        },
      ];
    } catch (error) {
      console.error("Failed to decode text file:", error);
      // Fall through to file part if decoding fails
    }
  }

  // Non-text files: return as file part
  return [
    {
      type: "file",
      url: `data:${mimeType};base64,${data}`,
      filename: mentionName,
      mediaType: mimeType,
    },
  ];
}

/**
 * Converts resource contents to UI message parts
 */
function resourcesToParts(
  contents: ReadResourceResult["contents"],
  mentionName: string,
): ChatMessage["parts"] {
  const parts: ChatMessage["parts"] = [];

  for (const content of contents) {
    if ("text" in content && content.text) {
      parts.push({
        type: "text",
        text: `[${mentionName}]\n${content.text}`,
      });
    } else if ("blob" in content && content.blob && content.mimeType) {
      parts.push({
        type: "file",
        url: `data:${content.mimeType};base64,${content.blob}`,
        filename: String(content.uri),
        mediaType: String(content.mimeType),
      });
    }
  }

  return parts;
}

/**
 * Converts prompt messages to UI message parts
 */
function promptMessagesToParts(
  messages: PromptMessage[],
  mentionName: string,
): ChatMessage["parts"] {
  const parts: ChatMessage["parts"] = [];

  for (const message of messages) {
    if (message.role !== "user" || !message.content) continue;

    const messageContents = Array.isArray(message.content)
      ? message.content
      : [message.content];

    for (const content of messageContents) {
      switch (content.type) {
        case "text": {
          const text = content.text?.trim();
          if (!text) {
            continue;
          }

          parts.push({
            type: "text",
            text: `[${mentionName}]\n${text}`,
          });
          break;
        }
        case "image":
        case "audio": {
          if (!content.data || !content.mimeType) {
            continue;
          }

          parts.push({
            type: "file",
            url: `data:${content.mimeType};base64,${content.data}`,
            mediaType: content.mimeType,
          });

          break;
        }
        case "resource": {
          const resource = content.resource as
            | EmbeddedResource["resource"]
            | undefined;

          if (!resource || !resource.mimeType) {
            continue;
          }

          if (resource) {
            if ("text" in resource && resource.text) {
              parts.push({
                type: "text",
                text: `[${mentionName}]\n${resource.text}`,
              });
            } else if (
              "blob" in resource &&
              resource.blob &&
              resource.mimeType
            ) {
              parts.push({
                type: "file",
                url: `data:${resource.mimeType};base64,${resource.blob}`,
                filename: String(resource.uri),
                mediaType: String(resource.mimeType),
              });
            }
          }
          break;
        }
      }
    }
  }

  return parts;
}

/**
 * Helper to derive UI parts from TiptapDoc
 * Walks the tiptap document to extract inline text and collect resources from prompt tags
 */
export function derivePartsFromTiptapDoc(
  doc: Metadata["tiptapDoc"],
): ChatMessage["parts"] {
  if (!doc) return [];

  const parts: ChatMessage["parts"] = [];
  let inlineText = "";

  // Walk the tiptap document to build inline text and collect resources
  const walkNode = (
    node:
      | Metadata["tiptapDoc"]
      | {
          type: string;
          attrs?: Record<string, unknown>;
          content?: unknown[];
          text?: string;
        },
  ) => {
    if (!node) return;

    if (
      node.type === "text" &&
      "text" in node &&
      typeof node.text === "string"
    ) {
      inlineText += node.text;
    } else if (node.type === "mention" && node.attrs) {
      const char = (node.attrs.char as string | undefined) ?? "/";
      const mentionName = `${char}${node.attrs.name}`;

      // Add label to inline text
      inlineText += mentionName;

      // Handle resource mentions (@) vs prompt mentions (/)
      if (char === "@") {
        // Resource mentions: metadata contains ReadResourceResult.contents directly
        const contents = (node.attrs.metadata ||
          []) as ReadResourceResult["contents"];
        parts.push(...resourcesToParts(contents, mentionName));
      } else {
        // Prompt mentions: metadata contains PromptMessage[]
        const prompts = (node.attrs.metadata ||
          node.attrs.prompts ||
          []) as PromptMessage[];
        parts.push(...promptMessagesToParts(prompts, mentionName));
      }
    } else if (node.type === "file" && node.attrs) {
      const fileAttrs = node.attrs as unknown as FileAttrs;
      const mentionName = `[file:://${encodeURIComponent(fileAttrs.name)}]`;

      inlineText += mentionName;

      parts.push(...fileAttrsToParts(fileAttrs, mentionName));
    }

    // Recursively walk content
    if ("content" in node && Array.isArray(node.content)) {
      for (const child of node.content) {
        walkNode(child as typeof node);
      }
    }
  };

  walkNode(doc);

  // Add inline text as first part if there is any
  if (inlineText.trim()) {
    parts.unshift({ type: "text", text: inlineText.trim() });
  }

  return parts;
}

/**
 * Converts a tiptap document to a ChatMessage array suitable for automation storage.
 * Stores the tiptapDoc in message metadata for round-trip loading.
 */
export function tiptapDocToMessages(doc: Metadata["tiptapDoc"]): ChatMessage[] {
  const parts = derivePartsFromTiptapDoc(doc);
  if (parts.length === 0) return [];
  return [
    {
      id: crypto.randomUUID(),
      role: "user" as const,
      parts,
      metadata: { tiptapDoc: doc },
    },
  ];
}
