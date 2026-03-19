"use client";

import { Button } from "@deco/ui/components/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { ShieldTick } from "@untitledui/icons";
import { useState } from "react";
import {
  usePreferences,
  type ToolApprovalLevel,
} from "@/web/hooks/use-preferences.ts";
import { getFriendlyToolName } from "../message/parts/tool-call-part/utils.tsx";
import { HighlightCard, Pagination } from "./card";

// ============================================================================
// Types
// ============================================================================

export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  friendlyName: string;
  input: unknown;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_DENY_REASON =
  "User denied this tool call, give other alternatives.";

const APPROVAL_LEVEL_OPTIONS: {
  value: ToolApprovalLevel;
  label: string;
}[] = [
  { value: "readonly", label: "Skip read-only" },
  { value: "auto", label: "Auto-approve all" },
];

// ============================================================================
// ApprovalLevelSelect
// ============================================================================

function ApprovalLevelSelect({ onYolo }: { onYolo: () => void }) {
  const [preferences, setPreferences] = usePreferences();

  const handleLevelChange = (value: string) => {
    const newLevel = value as ToolApprovalLevel;
    setPreferences({ ...preferences, toolApprovalLevel: newLevel });
    if (newLevel === "auto") {
      onYolo();
    }
  };

  return (
    <Select
      value={preferences.toolApprovalLevel}
      onValueChange={handleLevelChange}
    >
      <SelectTrigger
        size="xs"
        className="text-xs text-muted-foreground border-border/60 bg-transparent hover:bg-accent/60 h-7 gap-1"
        onClick={(e) => e.stopPropagation()}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {APPROVAL_LEVEL_OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ============================================================================
// ApprovalDetail - shows tool input as formatted code
// ============================================================================

function ApprovalDetail({ input }: { input: unknown }) {
  if (input === undefined || input === null) {
    return <div className="px-4 text-xs text-muted-foreground">No input</div>;
  }

  let formatted: string;
  try {
    formatted = JSON.stringify(input, null, 2);
  } catch {
    formatted = String(input);
  }

  return (
    <div className="px-4">
      <pre className="text-xs font-mono text-muted-foreground/70 whitespace-pre-wrap wrap-break-word max-h-32 overflow-y-auto rounded-md bg-muted/30 px-3 py-2">
        {formatted}
      </pre>
    </div>
  );
}

// ============================================================================
// ApprovalPrompt - aggregated approval UI with pagination
// ============================================================================

interface ApprovalPromptProps {
  approvals: PendingApproval[];
  onRespond: (approvalId: string, approved: boolean, reason?: string) => void;
}

function ApprovalPrompt({ approvals, onRespond }: ApprovalPromptProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  // Clamp index if list shrinks
  const safeIndex = Math.min(activeIndex, approvals.length - 1);
  const current = approvals[safeIndex];

  if (!current) return null;

  const handleDeny = () => {
    onRespond(current.approvalId, false, DEFAULT_DENY_REASON);
    // Keep index; list shrinks on re-render, clamp handles it
  };

  const handleAccept = () => {
    onRespond(current.approvalId, true);
  };

  const handleAcceptAll = () => {
    for (const approval of approvals) {
      onRespond(approval.approvalId, true);
    }
  };

  const goToPrev = () => {
    if (safeIndex > 0) setActiveIndex(safeIndex - 1);
  };

  const goToNext = () => {
    if (safeIndex < approvals.length - 1) setActiveIndex(safeIndex + 1);
  };

  const footerLeft = (
    <div className="flex items-center gap-2">
      <ApprovalLevelSelect onYolo={handleAcceptAll} />
      <Pagination
        current={safeIndex}
        total={approvals.length}
        onPrev={goToPrev}
        onNext={goToNext}
      />
    </div>
  );

  const footerRight = (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2.5 text-xs text-muted-foreground [@media(hover:hover)]:hover:text-foreground active:scale-[0.97] transition-transform"
        onClick={handleDeny}
      >
        Deny
      </Button>
      {approvals.length > 1 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-xs active:scale-[0.97] transition-transform"
          onClick={handleAcceptAll}
        >
          Accept All
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        className="h-7 px-2.5 text-xs active:scale-[0.97] transition-transform"
        onClick={handleAccept}
      >
        Accept
      </Button>
    </>
  );

  return (
    <HighlightCard
      title={current.friendlyName}
      footerLeft={footerLeft}
      footerRight={footerRight}
    >
      <ApprovalDetail input={current.input} />
    </HighlightCard>
  );
}

// ============================================================================
// ApprovalLoadingUI
// ============================================================================

function ApprovalLoadingUI() {
  return (
    <div className="flex items-center gap-2 p-4 border border-dashed rounded-lg bg-accent/50 w-[calc(100%-16px)] max-w-[584px] mx-auto mb-2">
      <ShieldTick className="size-5 text-muted-foreground shimmer" />
      <span className="text-sm text-muted-foreground shimmer">
        Preparing approval request...
      </span>
    </div>
  );
}

// ============================================================================
// ApprovalHighlight - wrapper for ChatHighlight
// ============================================================================

export function ApprovalHighlight({
  approvals,
  isStreaming,
  onRespond,
}: {
  approvals: PendingApproval[];
  isStreaming: boolean;
  onRespond: (approvalId: string, approved: boolean, reason?: string) => void;
}) {
  if (isStreaming && approvals.length === 0) {
    return <ApprovalLoadingUI />;
  }

  if (approvals.length === 0) {
    return null;
  }

  return <ApprovalPrompt approvals={approvals} onRespond={onRespond} />;
}

// ============================================================================
// Utility: extract pending approvals from message parts
// ============================================================================

export function extractPendingApprovals(
  parts: Array<{
    type: string;
    state?: string;
    approval?: { id: string };
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
  }>,
): PendingApproval[] {
  const result: PendingApproval[] = [];

  for (const part of parts) {
    if (
      "state" in part &&
      part.state === "approval-requested" &&
      "approval" in part &&
      part.approval?.id &&
      "toolCallId" in part &&
      part.toolCallId
    ) {
      const toolName =
        "toolName" in part && typeof part.toolName === "string"
          ? part.toolName
          : part.type.startsWith("tool-")
            ? part.type.replace("tool-", "")
            : "Tool";

      result.push({
        approvalId: part.approval.id,
        toolCallId: part.toolCallId,
        toolName,
        friendlyName: getFriendlyToolName(toolName),
        input: part.input,
      });
    }
  }

  return result;
}
