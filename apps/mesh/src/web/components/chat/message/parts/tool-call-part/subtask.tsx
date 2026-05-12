"use client";

import type { ToolSubtaskMetadata } from "../../use-filter-parts.ts";
import { IntegrationIcon } from "@/web/components/integration-icon";
import { useVirtualMCP, type ToolDefinition } from "@decocms/mesh-sdk";
import { Users03 } from "@untitledui/icons";
import type { SubtaskToolPart } from "../../../types.ts";
import { extractTextFromOutput, getToolPartErrorText } from "../utils.ts";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";

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

  const response = isError
    ? getToolPartErrorText(part)
    : (extractTextFromOutput(part.output) ?? "No output available");
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
 * Suspense fallback for SubtaskPart. Renders the exact same ToolCallShell shape
 * as the loaded view (so no CLS) — just with a default icon and a status-derived
 * title instead of the agent's icon and name.
 */
export function SubtaskPartFallback(props: SubtaskPartProps) {
  const { fallbackTitle, ...shell } = useSubtaskShellConfig(props);
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
