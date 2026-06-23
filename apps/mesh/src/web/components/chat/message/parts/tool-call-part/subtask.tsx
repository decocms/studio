"use client";

import type { ToolSubtaskMetadata } from "../../use-filter-parts.ts";
import { IntegrationIcon } from "@/web/components/integration-icon";
import { useVirtualMCP, type ToolDefinition } from "@decocms/mesh-sdk";
import { Tool02, Users03 } from "@untitledui/icons";
import type { TextUIPart } from "ai";
import type { SubtaskToolPart } from "../../../types.ts";
import { useSubtaskRun } from "../../../subtask-runs-context.tsx";
import { MessageTextPart } from "../text-part.tsx";
import { extractTextFromOutput, getToolPartErrorText } from "../utils.ts";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";

/**
 * Subtask tool output contract (set by createSubtaskTool's execute generator):
 *   { text: string; error?: string; finishReason?: FinishReason }
 *
 * Mirrors the server's toModelOutput so the UI shows the same content the
 * parent model received. Falls back to the legacy UIMessage shape for
 * historical tool calls predating the structured output.
 */
export function extractSubtaskResponse(output: unknown): string | null {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const o = output as {
      text?: unknown;
      error?: unknown;
      finishReason?: unknown;
    };
    const hasNewShape =
      typeof o.text === "string" ||
      typeof o.error === "string" ||
      typeof o.finishReason === "string";
    if (hasNewShape) {
      if (typeof o.error === "string" && o.error.length > 0) {
        return `Subtask failed: ${o.error}`;
      }
      const text = typeof o.text === "string" ? o.text.trim() : "";
      const stepLimitHit = o.finishReason === "length";
      if (text) {
        const prefix = stepLimitHit
          ? "[Subtask hit step limit — partial result below; consider narrowing the task.]\n\n"
          : "";
        return prefix + text;
      }
      if (stepLimitHit) {
        return "[Subtask hit step limit before producing a final report. The subagent did work but ran out of steps. Narrow the task or increase the budget.]";
      }
      return "Subtask completed (no output).";
    }
  }
  return extractTextFromOutput(output);
}

/**
 * A backgrounded subtask's tool call returns a `{ background: true }` START
 * marker; the real run streams in later as separate messages tagged with this
 * call's `jobId`. So this tool part renders as a `BackgroundSubtaskCard` that
 * nests that run, rather than the standard (synchronous) subtask card.
 */
function isBackgroundStart(output: unknown): boolean {
  return (
    !!output &&
    typeof output === "object" &&
    (output as { background?: unknown }).background === true
  );
}

interface SubtaskPartProps {
  part: SubtaskToolPart;
  /** Subtask metadata from data part */
  subtaskMeta?: ToolSubtaskMetadata;
  /** Tool annotations from data part (unused in chat) */
  annotations?: ToolDefinition["annotations"];
  /** Latency in seconds from data-tool-metadata part */
  latency?: number;
}

/**
 * Derives ToolCallShell config from a SubtaskToolPart — no agent data needed.
 * Shared between SubtaskPart (loaded) and SubtaskPartFallback (Suspense fallback),
 * so the two render identical shells aside from the agent-dependent title/icon.
 */
function useSubtaskShellConfig({
  part,
  subtaskMeta,
  latency,
}: SubtaskPartProps) {
  const isInputStreaming =
    part.state === "input-streaming" || part.state === "input-available";
  const isOutputStreaming =
    part.state === "output-available" && part.preliminary === true;
  const isComplete = part.state === "output-available" && !part.preliminary;
  const isError = part.state === "output-error";

  // Approval-requested parts render as idle inline (approval UI is in the highlight above input)
  const rawState = getEffectiveState(
    part.state,
    "preliminary" in part ? part.preliminary : false,
  );
  const effectiveState = rawState === "approval" ? "idle" : rawState;

  const fallbackTitle: string = isInputStreaming
    ? "Starting subtask..."
    : isOutputStreaming
      ? "Subtask running..."
      : isComplete
        ? "Subtask completed"
        : isError
          ? "Subtask failed"
          : "Subtask";

  const prompt = part.input?.prompt ?? "";
  const summary =
    part.state === "approval-requested"
      ? "Awaiting approval..."
      : prompt.length > 120
        ? prompt.slice(0, 120) + "…"
        : prompt;

  const extracted = isError
    ? getToolPartErrorText(part)
    : extractSubtaskResponse(part.output);
  // While the subtask is still streaming but no chunk has arrived yet, show
  // nothing rather than "No output available" — that text is for a genuinely
  // empty completed result, not for the in-flight gap before the first chunk.
  const isStreaming = isInputStreaming || isOutputStreaming;
  const response = extracted ?? (isStreaming ? "" : "No output available");
  const detail = `# Task\n${part.input?.prompt ?? "No prompt provided"}\n\n# ${isError ? "Error" : "Result"}\n${response}`;

  return {
    fallbackTitle,
    summary,
    usage: subtaskMeta?.usage,
    latency,
    detail,
    state: effectiveState,
  };
}

/**
 * A backgrounded subtask runs as its own serialized subagent run whose messages
 * are tagged with this tool call's `jobId` (`metadata.subtaskJobId`). They're
 * filtered out of the top-level list and rendered NESTED here, inside the tool
 * card — the subagent's streamed reply grows in the detail panel live (the card
 * auto-opens while running), Claude-Code style. No `useVirtualMCP` so the
 * Suspense fallback can render this without itself suspending.
 */
/** A single nested tool call — shows the tool name + its INPUT only (the
 *  subagent's tool outputs are intentionally hidden inside the parent card).
 *  A compact custom row rather than the full `MessagePart` switch, which would
 *  create an `assistant.tsx ↔ index` cycle (and render outputs). */
function NestedToolCall({
  part,
}: {
  part: { type?: string; toolName?: string; input?: unknown };
}) {
  const type = part.type ?? "";
  const name =
    type === "dynamic-tool" ? (part.toolName ?? "tool") : type.slice(5);
  const inputStr = part.input != null ? JSON.stringify(part.input) : "";
  const summary =
    inputStr.length > 80 ? `${inputStr.slice(0, 80)}…` : inputStr || undefined;
  const detail =
    part.input != null ? JSON.stringify(part.input, null, 2) : null;
  return (
    <ToolCallShell
      icon={<Tool02 />}
      title={name}
      summary={summary}
      state="idle"
      detail={detail}
      detailVariant="code"
    />
  );
}

function BackgroundSubtaskCard({ part }: SubtaskPartProps) {
  const jobId = (part.output as { jobId?: string } | undefined)?.jobId;
  const nested = useSubtaskRun(jobId);
  const prompt = part.input?.prompt ?? "No prompt provided";

  const items = nested.flatMap((m) => m.parts ?? []);
  const streaming =
    items.length === 0 ||
    items.some((p) => (p as { state?: string }).state === "streaming");

  const summary = prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt;

  return (
    <ToolCallShell
      icon={
        <IntegrationIcon
          icon={undefined}
          name="Subtask"
          size="2xs"
          className="rounded-xs"
          fallbackIcon={<Users03 />}
        />
      }
      title="Subtask"
      summary={summary}
      state={streaming ? "loading" : "idle"}
      defaultOpen
      forceOpen={streaming}
    >
      <div className="ml-[20px] pl-3 border-l border-border/30 mt-0.5 pb-2 flex flex-col gap-3 sm:gap-2 max-h-96 overflow-y-auto">
        {items.length === 0 ? (
          <p className="text-[13px] text-muted-foreground/60 italic py-1">
            Running in the background…
          </p>
        ) : (
          items.map((raw, i) => {
            const p = raw as {
              type?: string;
              text?: string;
              state?: string;
              toolName?: string;
              input?: unknown;
            };
            const type = p.type ?? "";
            if (type === "text") {
              if (!p.text?.trim()) return null;
              return (
                <MessageTextPart
                  key={`${jobId}-sub-${i}`}
                  id={`${jobId}-sub-${i}`}
                  part={raw as TextUIPart}
                  animate={streaming}
                />
              );
            }
            // Hidden bookkeeping tools (same as the top-level renderer) + data
            // parts carry no useful "tool call" signal here.
            if (
              type === "dynamic-tool" ||
              (type.startsWith("tool-") &&
                type !== "tool-todo_write" &&
                type !== "tool-update_interests")
            ) {
              return <NestedToolCall key={`${jobId}-sub-${i}`} part={p} />;
            }
            return null;
          })
        )}
      </div>
    </ToolCallShell>
  );
}

export function SubtaskPartFallback(props: SubtaskPartProps) {
  const { fallbackTitle, ...shell } = useSubtaskShellConfig(props);
  if (isBackgroundStart(props.part.output))
    return <BackgroundSubtaskCard {...props} />;
  return (
    <ToolCallShell
      icon={
        <IntegrationIcon
          icon={undefined}
          name="Subtask"
          size="2xs"
          className="rounded-xs"
          fallbackIcon={<Users03 />}
        />
      }
      title={fallbackTitle}
      {...shell}
    />
  );
}

/**
 * Suspends on the agent fetch (useVirtualMCP). MUST be wrapped in
 * <Suspense fallback={<SubtaskPartFallback ... />}> by the caller.
 */
export function SubtaskPart(props: SubtaskPartProps) {
  const { fallbackTitle, ...shell } = useSubtaskShellConfig(props);
  const agent = useVirtualMCP(props.part.input?.agent_id);
  if (isBackgroundStart(props.part.output))
    return <BackgroundSubtaskCard {...props} />;

  return (
    <ToolCallShell
      icon={
        <IntegrationIcon
          icon={agent?.icon}
          name={agent?.title ?? "Subtask"}
          size="2xs"
          className="rounded-xs"
          fallbackIcon={<Users03 />}
        />
      }
      title={agent?.title ?? fallbackTitle}
      {...shell}
    />
  );
}
