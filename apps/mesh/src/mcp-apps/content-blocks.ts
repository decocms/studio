import type { McpUiMessageRequest } from "@modelcontextprotocol/ext-apps";
import type { JSONContent } from "@tiptap/core";
import type { TiptapDoc } from "@/web/components/chat/types.ts";

type AppContentBlock = McpUiMessageRequest["params"]["content"][number];

/** Approximate decoded byte size from a base64 string length. */
function base64ByteSize(encoded: string): number {
  return Math.ceil((encoded.length * 3) / 4);
}

export function contentBlocksToTiptapDoc(
  content: AppContentBlock[],
): TiptapDoc {
  const nodes: JSONContent[] = [];

  for (const block of content) {
    switch (block.type) {
      case "text":
        if (block.text?.trim()) {
          nodes.push({
            type: "paragraph",
            content: [{ type: "text", text: block.text }],
          });
        }
        break;
      case "image":
      case "audio":
        if (block.data && block.mimeType) {
          nodes.push({
            type: "paragraph",
            content: [
              {
                type: "file",
                attrs: {
                  id: crypto.randomUUID(),
                  name: `${block.type}.${block.mimeType.split("/")[1] ?? "bin"}`,
                  mimeType: block.mimeType,
                  size: base64ByteSize(block.data),
                  data: block.data,
                },
              },
            ],
          });
        }
        break;
      case "resource": {
        const res = block.resource;
        if ("text" in res && res.text) {
          nodes.push({
            type: "paragraph",
            content: [{ type: "text", text: res.text }],
          });
        } else if ("blob" in res && res.blob) {
          nodes.push({
            type: "paragraph",
            content: [
              {
                type: "file",
                attrs: {
                  id: crypto.randomUUID(),
                  name: String(res.uri),
                  mimeType: res.mimeType ?? "application/octet-stream",
                  size: base64ByteSize(res.blob),
                  data: res.blob,
                },
              },
            ],
          });
        }
        break;
      }
      case "resource_link":
        nodes.push({
          type: "paragraph",
          content: [{ type: "text", text: block.name ?? block.uri }],
        });
        break;
    }
  }

  return { type: "doc", content: nodes };
}
