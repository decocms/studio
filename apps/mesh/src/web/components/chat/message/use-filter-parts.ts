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
      }
    }
  }

  // Build render order: within each step, reasoning groups come first.
  // A "step" is delimited by step-start parts.
  const renderOrder: RenderItem[] = [];

  if (message) {
    // Collect items per step, then flush with reasoning-groups first
    let stepReasoningGroups: ReasoningGroup[] = [];
    let stepParts: { index: number }[] = [];
    const groupsEmitted = new Set<ReasoningGroup>();

    const flushStep = () => {
      for (const group of stepReasoningGroups) {
        if (!groupsEmitted.has(group)) {
          groupsEmitted.add(group);
          renderOrder.push({ kind: "reasoning-group", group });
        }
      }
      for (const item of stepParts) {
        renderOrder.push({ kind: "part", index: item.index });
      }
      stepReasoningGroups = [];
      stepParts = [];
    };

    for (let i = 0; i < message.parts.length; i++) {
      const p = message.parts[i]!;

      if (p.type === "step-start") {
        flushStep();
        continue;
      }

      // Skip individual reasoning parts (handled as groups)
      if (reasoningIndices.has(i)) {
        // If this is the first index of a group, queue it
        const group = reasoningGroups.find((g) => g.startIndex === i);
        if (group) {
          stepReasoningGroups.push(group);
        }
        continue;
      }

      stepParts.push({ index: i });
    }

    // Flush the last step
    flushStep();
  }

  return {
    reasoningGroups,
    renderOrder,
    dataParts: { toolMetadata, toolSubtaskMetadata },
  };
}
