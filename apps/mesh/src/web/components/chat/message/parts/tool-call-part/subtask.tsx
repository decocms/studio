"use client";

import type { ToolSubtaskMetadata } from "../../use-filter-parts.ts";
import { IntegrationIcon } from "@/web/components/integration-icon";
import type { ToolDefinition } from "@decocms/mesh-sdk";
import { Users03 } from "@untitledui/icons";
import { useChatStable } from "../../../context.tsx";
import type { SubtaskToolPart } from "../../../types.ts";
import { extractTextFromOutput, getToolPartErrorText } from "../utils.ts";
import { ToolCallShell } from "./common.tsx";
import { ApprovalActions } from "./approval-actions.tsx";
import { getApprovalId, getEffectiveState } from "./utils.tsx";

interface SubtaskPartProps {
  part: SubtaskToolPart;
  /** Subtask metadata from data part */
  subtaskMeta?: ToolSubtaskMetadata;
  /** Tool annotations from data part */
  annotations?: ToolDefinition["annotations"];
  /** Latency in seconds from data-tool-metadata part */
  latency?: number;
}

export function SubtaskPart({
  part,
  subtaskMeta,
  annotations,
  latency,
}: SubtaskPartProps) {
  const { virtualMcps } = useChatStable();

  // State computation
  const isInputStreaming =
    part.state === "input-streaming" || part.state === "input-available";
  const isOutputStreaming =
    part.state === "output-available" && part.preliminary === true;
  const isComplete = part.state === "output-available" && !part.preliminary;
  const isError = part.state === "output-error";

  // Derive UI state for ToolCallShell
  const effectiveState = getEffectiveState(
    part.state,
    "preliminary" in part ? part.preliminary : false,
  );

  // Agent lookup
  const agentId = part.input?.agent_id;
  const agent = agentId ? virtualMcps.find((v) => v.id === agentId) : null;

  // Usage extraction from data part
  const usage = subtaskMeta?.usage;

  // Title mapping
  const title: string = agent?.title
    ? agent.title
    : isInputStreaming
      ? "Starting subtask..."
      : isOutputStreaming
        ? "Subtask running..."
        : isComplete
          ? "Subtask completed"
          : isError
            ? "Subtask failed"
            : "Subtask";

  // Summary (task prompt)
  const summary = part.input?.prompt ?? "";

  // Detail (expanded content)
  const response = isError
    ? getToolPartErrorText(part)
    : (extractTextFromOutput(part.output) ?? "No output available");
  const detail = `# Task\n${part.input?.prompt ?? "No prompt provided"}\n\n# ${isError ? "Error" : "Execution"}\n${response}`;

  // Icon
  const icon = (
    <IntegrationIcon
      icon={agent?.icon}
      name={agent?.title ?? "Subtask"}
      size="2xs"
      fallbackIcon={<Users03 />}
    />
  );

  // Build approval actions for approval-requested state
  const approvalId = getApprovalId(part);
  const actions = approvalId ? (
    <ApprovalActions approvalId={approvalId} />
  ) : undefined;

  return (
    <div className="my-2">
      <ToolCallShell
        icon={icon}
        title={title}
        summary={summary}
        usage={usage}
        latency={latency}
        detail={detail}
        annotations={annotations}
        state={effectiveState}
        actions={actions}
      />
    </div>
  );
}
