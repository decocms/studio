/**
 * Demo Mode — builders for scripted chat content.
 *
 * These produce the exact `ChatMessage` / UIMessage part shapes the REAL chat
 * renderers consume (`message/assistant.tsx`, `parts/tool-call-part/*`), so a
 * scripted turn is pixel-identical to a live one. The Director owns timing and
 * state transitions; these are pure data factories.
 *
 * Tool parts follow the AI-SDK v5 `ToolUIPart` shape:
 *   { type: `tool-${name}`, toolCallId, state, input, output }
 * with the matching `data-tool-metadata` part (keyed by the same id) carrying
 * latency for the usage/latency chips.
 */
import type { ChatMessage } from "@/web/components/chat/types";

type Part = ChatMessage["parts"][number];

/**
 * A declarative tool step. The Director assigns the `toolCallId`, drives the
 * `input-available → output-available` transition, and emits the latency
 * metadata part. Scripts just describe the call and its result.
 */
export interface ToolStep {
  /** built-in tool name without the `tool-` prefix, e.g. "take_screenshot" */
  name: string;
  input: unknown;
  output: unknown;
  /** time spent in the loading state before the output lands (ms) */
  latencyMs: number;
}

export function userMessage(text: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
    metadata: {
      created_at: new Date().toISOString(),
      user: { name: "You" },
    },
  } as ChatMessage;
}

export function emptyAssistant(): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [],
    metadata: { created_at: new Date().toISOString() },
  } as ChatMessage;
}

/** A tool part in its in-flight (loading) state. */
export function toolPartPending(
  name: string,
  toolCallId: string,
  input: unknown,
): Part {
  return {
    type: `tool-${name}`,
    toolCallId,
    state: "input-available",
    input,
  } as unknown as Part;
}

/** Inline work-plan (sprint) card part — rendered by the demo part registry. */
export function workPlanPart(output: unknown): Part {
  return {
    type: "tool-work_plan",
    toolCallId: crypto.randomUUID(),
    state: "output-available",
    output,
  } as unknown as Part;
}

/** Inline pull-request card part — rendered by the demo part registry. */
export function pullRequestPart(output: unknown): Part {
  return {
    type: "tool-pull_request",
    toolCallId: crypto.randomUUID(),
    state: "output-available",
    output,
  } as unknown as Part;
}

/** Inline "get this daily" digest card part — rendered by the demo registry. */
export function dailyDigestPart(output: unknown): Part {
  return {
    type: "tool-daily_digest",
    toolCallId: crypto.randomUUID(),
    state: "output-available",
    output,
  } as unknown as Part;
}

/** The latency-carrying metadata part (id MUST equal the tool's toolCallId). */
export function toolMetadataPart(toolCallId: string, latencyMs: number): Part {
  return {
    type: "data-tool-metadata",
    id: toolCallId,
    data: { latencyMs },
  } as unknown as Part;
}

// ============================================================================
// Tool step factories (one per renderer we drive)
// ============================================================================

/** `take_screenshot` — `image.uri` is used as-is when not a mesh-storage key,
 *  so a `data:` URI or absolute/relative asset URL renders directly. */
export function takeScreenshot(args: {
  url: string;
  image: string;
  latencyMs?: number;
}): ToolStep {
  return {
    name: "take_screenshot",
    input: { url: args.url, fullPage: true },
    output: {
      success: true,
      url: args.url,
      image: { uri: args.image, mediaType: "image/png" },
    },
    latencyMs: args.latencyMs ?? 1600,
  };
}

/** `propose_plan` — renders the "Implementation Plan" card (collapsible
 *  markdown). `approved: true` shows the green Approved badge. */
export function proposePlan(args: {
  plan: string;
  approved?: boolean;
  latencyMs?: number;
}): ToolStep {
  return {
    name: "propose_plan",
    input: { plan: args.plan },
    output: { approved: args.approved ?? true },
    latencyMs: args.latencyMs ?? 800,
  };
}

/** A generic tool call rendered by `GenericToolCallPart`. */
export function genericTool(args: {
  name: string;
  input?: unknown;
  output?: unknown;
  latencyMs?: number;
}): ToolStep {
  return {
    name: args.name,
    input: args.input ?? {},
    output: args.output ?? { success: true },
    latencyMs: args.latencyMs ?? 1000,
  };
}

/** A pre-resolved custom card part for any registered demo renderer
 *  (`tool-<type>`) — for static cards with no post-render state updates. */
export function customCardPart(type: string, output: unknown): Part {
  return {
    type: `tool-${type}`,
    toolCallId: crypto.randomUUID(),
    state: "output-available",
    output,
  } as unknown as Part;
}
