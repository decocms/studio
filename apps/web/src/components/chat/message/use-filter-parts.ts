import type { ToolDefinition, UsageStats } from "@/sdk";
import type { ModelsConfig } from "@decocms/shared/harness/types";
import type { ChatMessage } from "../types.ts";

type MessagePart = ChatMessage["parts"][number];
type ReasoningPart = Extract<MessagePart, { type: "reasoning" }>;

function isReasoningPart(part: MessagePart): part is ReasoningPart {
  return part.type === "reasoning";
}

export interface ToolMetadata {
  annotations?: NonNullable<ToolDefinition["annotations"]>;
  /** Latency in seconds (converted from ms for UI) */
  latencySeconds?: number;
  /** UTF-8 byte length of the JSON-serialized tool result. */
  outputBytes?: number;
  _meta?: ToolDefinition["_meta"];
}

export interface ToolSubtaskMetadata {
  usage: UsageStats;
  agent: string;
  /** Slot-keyed harness models (per-slot credentialId, v2). */
  models: ModelsConfig;
}

export interface DataParts {
  toolMetadata: Map<string, ToolMetadata>;
  toolSubtaskMetadata: Map<string, ToolSubtaskMetadata>;
  /** Accumulated streaming text from data-web-search parts, keyed by toolCallId */
  webSearchStreaming: Map<string, string>;
}

export interface ReasoningGroup {
  parts: ReasoningPart[];
  /** Index in the original parts array where this group starts */
  startIndex: number;
}

/**
 * A tagged union for what to render at each position.
 * - "reasoning-group": render a ThoughtSummary for the group
 * - "part": render the normal MessagePart at this index
 */
export type RenderItem =
  | { kind: "reasoning-group"; group: ReasoningGroup }
  | { kind: "part"; index: number };

export function useFilterParts(message: ChatMessage | null) {
  const reasoningGroups: ReasoningGroup[] = [];
  const reasoningIndices = new Set<number>();
  const toolMetadata = new Map<string, ToolMetadata>();
  const toolSubtaskMetadata = new Map<string, ToolSubtaskMetadata>();
  const webSearchStreaming = new Map<string, string>();

  if (message) {
    let currentGroup: ReasoningGroup | null = null;

    for (let i = 0; i < message.parts.length; i++) {
      const p = message.parts[i]!;

      if (isReasoningPart(p)) {
        if (!currentGroup) {
          currentGroup = { parts: [], startIndex: i };
          reasoningGroups.push(currentGroup);
        }
        currentGroup.parts.push(p);
        reasoningIndices.add(i);
        continue;
      }

      // Non-reasoning part: close current group
      currentGroup = null;

      if (p.type === "data-tool-metadata" && "id" in p && "data" in p) {
        const data = (
          p as {
            data: {
              annotations?: unknown;
              latencyMs?: number;
              outputBytes?: number;
              _meta?: unknown;
            };
          }
        ).data;
        const meta: ToolMetadata = {};
        if (data.annotations) {
          meta.annotations = data.annotations as NonNullable<
            ToolDefinition["annotations"]
          >;
        }
        if (
          typeof data.latencyMs === "number" &&
          Number.isFinite(data.latencyMs)
        ) {
          meta.latencySeconds = data.latencyMs / 1000;
        }
        if (
          typeof data.outputBytes === "number" &&
          Number.isFinite(data.outputBytes) &&
          data.outputBytes >= 0
        ) {
          meta.outputBytes = data.outputBytes;
        }
        if (data._meta && typeof data._meta === "object") {
          meta._meta = data._meta as ToolDefinition["_meta"];
        }
        toolMetadata.set((p as { id: string }).id, meta);
        continue;
      }

      if (p.type === "data-tool-subtask-metadata" && "id" in p) {
        toolSubtaskMetadata.set(
          (p as { id: string }).id,
          (p as { data: ToolSubtaskMetadata }).data,
        );
        continue;
      }

      if (p.type === "data-web-search" && "id" in p && "data" in p) {
        const id = (p as { id: string }).id;
        const data = (p as { data: { text?: string } }).data;
        webSearchStreaming.set(id, data.text ?? "");
        continue;
      }
    }
  }

  // Build render order in pure arrival order: each reasoning group renders at
  // the position of its first part, interleaved with the surrounding tool calls
  // and text exactly as the model produced them. Adjacent reasoning parts are
  // still coalesced into one group above; we deliberately do NOT hoist groups
  // to the top of their step. With interleaved thinking a single step can emit
  // reasoning → tool → reasoning → tool …, and hoisting collapsed all those
  // thoughts into one disconnected stack above the tools.
  const renderOrder: RenderItem[] = [];

  if (message) {
    for (let i = 0; i < message.parts.length; i++) {
      const p = message.parts[i]!;

      // step-start parts are structural only — they never render.
      if (p.type === "step-start") {
        continue;
      }

      // Reasoning parts render as groups. Emit the group once, at the index of
      // its first part; later parts of the same group emit nothing.
      if (reasoningIndices.has(i)) {
        const group = reasoningGroups.find((g) => g.startIndex === i);
        if (group) {
          renderOrder.push({ kind: "reasoning-group", group });
        }
        continue;
      }

      // Skip invisible data-* parts (they're consumed above into the
      // dataParts maps and the MessagePart switch returns null for them).
      // Including them in renderOrder would let them claim
      // `isLastVisiblePart` and steal the message-bottom usage stats from
      // the real last visible part.
      if (p.type.startsWith("data-")) {
        continue;
      }

      renderOrder.push({ kind: "part", index: i });
    }
  }

  return {
    reasoningGroups,
    renderOrder,
    dataParts: {
      toolMetadata,
      toolSubtaskMetadata,
      webSearchStreaming,
    },
  };
}
