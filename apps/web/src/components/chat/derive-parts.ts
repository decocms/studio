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
import { agentMentionContext } from "@decocms/shared/agent-mention";
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
    if (!content || typeof content !== "object") continue;
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

interface SkillFile {
  relPath: string;
  content: string;
}

/**
 * Converts a skill mention to a UI message part, mirroring how MCP prompts are
 * inlined (a `[/label]` header + the content, no extra prose). The markdown/text
 * docs are baked in — each wrapped in a `<skill-file path="…">` delimiter — and
 * files left on disk (scripts/assets) are surfaced as a compact path list under
 * the mount, so the agent knows what's there without re-reading the skill.
 */
function skillMentionToParts(
  meta: {
    sandboxPath: string;
    files: SkillFile[];
    omittedPaths?: string[];
  },
  mentionName: string,
): ChatMessage["parts"] {
  const files = (meta.files ?? []).filter((f) => f.content?.trim());
  const omitted = meta.omittedPaths ?? [];
  if (files.length === 0 && omitted.length === 0) return [];

  const blocks = files
    .map(
      (f) =>
        `<skill-file path="${f.relPath}">\n${f.content.trim()}\n</skill-file>`,
    )
    .join("\n\n");
  const omittedLine =
    omitted.length > 0
      ? `\n\nOther files in \`${meta.sandboxPath}/\`: ${omitted.join(", ")}`
      : "";

  return [
    {
      type: "text",
      text: `[${mentionName}]\n${blocks}${omittedLine}`,
    },
  ];
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
 * Node types that occupy their own line. Tiptap keeps no newline of its own —
 * the break IS the block boundary — so the walk has to put one back.
 */
const BLOCK_NODES = new Set(["paragraph", "heading", "codeBlock"]);

type TextMark = { type: string; attrs?: Record<string, unknown> };

const MARK_DELIMITERS: Record<string, string> = {
  bold: "**",
  italic: "_",
  strike: "~~",
  code: "`",
};

/** An autolinked URL already reads as its own link; `[x](x)` is noise. */
function linkShowsItsHref(text: string, href: string): boolean {
  return (
    href === text || href.replace(/^(?:[a-z]+:\/\/|mailto:)/i, "") === text
  );
}

/**
 * A text node as markdown, so the model sees the formatting the user sees.
 * Whitespace stays outside the delimiters — `** bold**` is not bold.
 */
function textNodeToMarkdown(text: string, marks?: TextMark[]): string {
  if (!marks?.length) return text;
  const [, lead = "", core = "", trail = ""] =
    /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? [];
  if (!core) return text;

  let out = core;
  // Code goes innermost: anything inside backticks is literal.
  const ordered = [...marks].sort(
    (a, b) => Number(b.type === "code") - Number(a.type === "code"),
  );
  for (const mark of ordered) {
    const delimiter = MARK_DELIMITERS[mark.type];
    if (delimiter) out = `${delimiter}${out}${delimiter}`;
  }
  const link = marks.find((m) => m.type === "link");
  const href = link?.attrs?.href;
  if (typeof href === "string" && href && !linkShowsItsHref(core, href)) {
    out = `[${out}](${href})`;
  }
  return `${lead}${out}${trail}`;
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
  let listDepth = 0;
  // A list item's marker is already on the line its first paragraph fills.
  let markerOpen = false;

  // Walk the tiptap document to build inline text and collect resources
  const walkNode = (
    node:
      | Metadata["tiptapDoc"]
      | {
          type: string;
          attrs?: Record<string, unknown>;
          content?: unknown[];
          text?: string;
          marks?: TextMark[];
        },
  ) => {
    if (!node) return;

    const indent = "  ".repeat(listDepth);

    if (node.type === "bulletList" || node.type === "orderedList") {
      const start =
        typeof node.attrs?.start === "number" ? node.attrs.start : 1;
      const items =
        "content" in node && Array.isArray(node.content) ? node.content : [];
      items.forEach((item, index) => {
        if (inlineText !== "") inlineText += "\n";
        inlineText +=
          indent + (node.type === "orderedList" ? `${start + index}. ` : "- ");
        markerOpen = true;
        listDepth++;
        walkNode(item as typeof node);
        listDepth--;
        markerOpen = false;
      });
      return;
    }

    // A block starts a new line. Without this every paragraph ran into the
    // previous one, so a two-paragraph message reached the model as one — and
    // a prompt saved from this editor lost the blank lines that make its
    // markdown parse (a heading glued to the line above is body text).
    if (BLOCK_NODES.has(node.type ?? "")) {
      if (markerOpen) markerOpen = false;
      else if (inlineText !== "") inlineText += "\n" + indent;
    }

    if (node.type === "hardBreak") {
      inlineText += "\n" + indent;
    } else if (
      node.type === "text" &&
      "text" in node &&
      typeof node.text === "string"
    ) {
      inlineText += textNodeToMarkdown(node.text, node.marks);
    } else if (node.type === "mention" && node.attrs) {
      const char = (node.attrs.char as string | undefined) ?? "/";
      const mentionName = `${char}${node.attrs.name}`;

      if (node.attrs.kind === "task") {
        // Task ref chip: expand to the task's title + description as its own
        // text part. Kept out of `inlineText` so the user's own words (if any)
        // read as the message and the task is context alongside them.
        const meta = node.attrs.metadata as {
          title?: string;
          description?: string | null;
          // Prebuilt at chat-start (buildTaskChatContext): title + description
          // plus the task's linked PRs and other chats. Older drafts lack it,
          // so fall back to title + description.
          context?: string;
        } | null;
        const title = meta?.title ?? (node.attrs.name as string) ?? "";
        const body =
          meta?.context?.trim() ||
          [title, meta?.description?.trim()].filter(Boolean).join("\n\n");
        if (body) parts.push({ type: "text", text: body });
        return;
      }

      // Add label to inline text
      inlineText += mentionName;

      if (char === "@") {
        // @ mentions can be agents or resources — distinguish by metadata shape
        const meta = node.attrs.metadata as
          | Record<string, unknown>
          | unknown[]
          | null;
        if (
          meta &&
          typeof meta === "object" &&
          !Array.isArray(meta) &&
          "agentId" in meta
        ) {
          parts.push({
            type: "text",
            text: agentMentionContext({
              title:
                (meta as { title?: string }).title ?? String(node.attrs.name),
              agentId: (meta as { agentId: string }).agentId,
            }),
          });
        } else if (Array.isArray(meta)) {
          // Resource mention: metadata is ReadResourceResult.contents
          parts.push(
            ...resourcesToParts(
              meta as ReadResourceResult["contents"],
              mentionName,
            ),
          );
        }
      } else if (node.attrs.kind === "skill") {
        // Skill mention: SKILL.md + sibling files inlined, plus a disk pointer.
        const meta = node.attrs.metadata as
          | {
              sandboxPath: string;
              files: SkillFile[];
              omittedPaths?: string[];
            }
          | null
          | undefined;
        if (meta && !Array.isArray(meta) && Array.isArray(meta.files)) {
          parts.push(...skillMentionToParts(meta, mentionName));
        }
      } else {
        // Slash mentions: prompts or resources (both use "/")
        // Distinguish by metadata shape: arrays with "role" = prompts, arrays with "uri" = resources
        const metadata = node.attrs.metadata || node.attrs.prompts || [];
        if (
          Array.isArray(metadata) &&
          metadata.length > 0 &&
          typeof metadata[0] === "object" &&
          metadata[0] !== null &&
          "role" in metadata[0]
        ) {
          // Prompt messages
          parts.push(
            ...promptMessagesToParts(metadata as PromptMessage[], mentionName),
          );
        } else if (Array.isArray(metadata)) {
          // Resource contents
          parts.push(
            ...resourcesToParts(
              metadata as ReadResourceResult["contents"],
              mentionName,
            ),
          );
        }
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
