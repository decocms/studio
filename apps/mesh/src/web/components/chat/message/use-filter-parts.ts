import type { ToolDefinition, UsageStats } from "@decocms/mesh-sdk";
import type { ModelsConfig } from "@/api/routes/decopilot/types";
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
  _meta?: ToolDefinition["_meta"];
}

export interface ToolSubtaskMetadata {
  usage: UsageStats;
  agent: string;
  models: ModelsConfig;
}

export interface DataParts {
  toolMetadata: Map<string, ToolMetadata>;
  toolSubtaskMetadata: Map<string, ToolSubtaskMetadata>;
  promptSuggestions: string[];
}

export function useFilterParts(message: ChatMessage | null) {
  const reasoningParts: ReasoningPart[] = [];
  const toolMetadata = new Map<string, ToolMetadata>();
  const toolSubtaskMetadata = new Map<string, ToolSubtaskMetadata>();
  const promptSuggestions: string[] = [];

  if (message) {
    for (const p of message.parts) {
      if (isReasoningPart(p)) {
        reasoningParts.push(p);
        continue;
      }

      if (p.type === "data-tool-metadata" && "id" in p && "data" in p) {
        const data = (
          p as {
            data: {
              annotations?: unknown;
              latencyMs?: number;
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

      if (p.type === "data-prompt-suggestion" && "data" in p) {
        const data = (p as { data: { suggestion?: string } }).data;
        if (data.suggestion) {
          promptSuggestions.push(data.suggestion);
        }
      }
    }
  }

  return {
    reasoningParts,
    dataParts: { toolMetadata, toolSubtaskMetadata, promptSuggestions },
  };
}
