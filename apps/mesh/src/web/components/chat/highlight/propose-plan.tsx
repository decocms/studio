"use client";

import { Button } from "@deco/ui/components/button.tsx";
import { Check } from "@untitledui/icons";
import { HighlightCard } from "./card";
import { MessageTextPart } from "../message/parts/text-part.tsx";
import type { ChatMessage } from "../types.ts";

// ============================================================================
// Types
// ============================================================================

export interface PendingPlan {
  toolCallId: string;
  plan: string;
  state: string;
}

// ============================================================================
// ProposePlanPrompt - Plan card with approve/reject buttons
// ============================================================================

interface ProposePlanPromptProps {
  plan: PendingPlan;
  onRespond: (toolCallId: string, approved: boolean) => void;
}

function ProposePlanPrompt({ plan, onRespond }: ProposePlanPromptProps) {
  const handleApprove = () => {
    onRespond(plan.toolCallId, true);
  };

  const handleReject = () => {
    onRespond(plan.toolCallId, false);
  };

  const footerRight = (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2.5 text-xs text-muted-foreground [@media(hover:hover)]:hover:text-foreground active:scale-[0.97] transition-transform"
        onClick={handleReject}
      >
        Keep iterating
      </Button>
      <Button
        type="button"
        size="sm"
        className="h-7 px-2.5 text-xs bg-purple-600 hover:bg-purple-700 text-white active:scale-[0.97] transition-transform"
        onClick={handleApprove}
      >
        Let&apos;s go
      </Button>
    </>
  );

  return (
    <HighlightCard title="Implementation Plan" footerRight={footerRight}>
      <div className="px-4 max-h-64 overflow-y-auto">
        <div className="prose prose-sm max-w-none text-sm">
          <MessageTextPart
            id="plan-preview"
            part={{ type: "text", text: plan.plan }}
          />
        </div>
      </div>
    </HighlightCard>
  );
}

// ============================================================================
// ProposePlanLoadingUI
// ============================================================================

function ProposePlanLoadingUI() {
  return (
    <div className="flex items-center gap-2 p-4 border border-dashed border-purple-500/30 rounded-lg bg-purple-500/5 w-[calc(100%-16px)] max-w-[584px] mx-auto mb-2">
      <Check className="size-5 text-purple-500 shimmer" />
      <span className="text-sm text-muted-foreground shimmer">
        Preparing plan...
      </span>
    </div>
  );
}

// ============================================================================
// ProposePlanHighlight - wrapper for ChatHighlight
// ============================================================================

export function ProposePlanHighlight({
  plans,
  isStreaming,
  onRespond,
}: {
  plans: PendingPlan[];
  isStreaming: boolean;
  onRespond: (toolCallId: string, approved: boolean) => void;
}) {
  if (isStreaming && plans.length === 0) {
    return <ProposePlanLoadingUI />;
  }

  // Show only the last pending plan
  const activePlan = plans.at(-1);
  if (!activePlan) {
    return null;
  }

  return <ProposePlanPrompt plan={activePlan} onRespond={onRespond} />;
}

// ============================================================================
// Utility: extract pending propose_plan parts from message
// ============================================================================

export function extractPendingPlans(
  parts: ChatMessage["parts"],
): PendingPlan[] {
  const result: PendingPlan[] = [];

  for (const part of parts) {
    if (
      "type" in part &&
      (part as { type: string }).type === "tool-propose_plan" &&
      "state" in part &&
      (part as { state: string }).state === "input-available" &&
      "toolCallId" in part &&
      "input" in part
    ) {
      const input = (part as { input: { plan: string } }).input;
      result.push({
        toolCallId: (part as { toolCallId: string }).toolCallId,
        plan: input.plan,
        state: (part as { state: string }).state,
      });
    }
  }

  return result;
}
