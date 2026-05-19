"use client";

import { Button } from "@deco/ui/components/button.tsx";
import { Form } from "@deco/ui/components/form.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { ShieldTick } from "@untitledui/icons";
import { type Control, Controller } from "react-hook-form";
import { z } from "zod";
import {
  APPROVAL_LEVEL_OPTIONS,
  usePreferences,
  type ToolApprovalLevel,
} from "@/web/hooks/use-preferences.ts";
import { stripMcpServerPrefix } from "@/web/lib/tool-namespace";
import { toTitleCase } from "../message/parts/tool-call-part/utils.tsx";
import { CollapsibleHighlight } from "./collapsible-highlight";
import { PaginatedFormFooterLeft } from "./common/paginated-form-footer";
import { useMultiPartDecisionForm } from "./common/use-multipart-decision-form";

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

// ============================================================================
// ApprovalLevelSelect
// ============================================================================

function ApprovalLevelSelect({
  onYolo,
}: {
  onYolo: (level: ToolApprovalLevel) => void;
}) {
  const [preferences, setPreferences] = usePreferences();

  const handleLevelChange = (value: string) => {
    const newLevel = value as ToolApprovalLevel;
    setPreferences({ ...preferences, toolApprovalLevel: newLevel });
    if (newLevel === "auto") {
      onYolo(newLevel);
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
// ApprovalDetail
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
// Single-approval branch — instant fire, no Submit
// ============================================================================

interface SingleApprovalPromptProps {
  approval: PendingApproval;
  onRespond: (
    approvalId: string,
    approved: boolean,
    reason: string | undefined,
    toolApprovalLevel: ToolApprovalLevel,
  ) => void;
}

function SingleApprovalPrompt({
  approval,
  onRespond,
}: SingleApprovalPromptProps) {
  const [preferences] = usePreferences();
  const currentLevel: ToolApprovalLevel =
    preferences.toolApprovalLevel ?? "readonly";

  const handleDeny = () =>
    onRespond(approval.approvalId, false, DEFAULT_DENY_REASON, currentLevel);
  const handleAccept = () =>
    onRespond(approval.approvalId, true, undefined, currentLevel);
  const handleAcceptAll = (level: ToolApprovalLevel) =>
    onRespond(approval.approvalId, true, undefined, level);

  const footerLeft = (
    <div className="flex items-center gap-2">
      <ApprovalLevelSelect onYolo={handleAcceptAll} />
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
    <CollapsibleHighlight
      icon={<ShieldTick size={14} />}
      label="Approval needed"
      title={approval.friendlyName}
      defaultExpanded={true}
      footerLeft={footerLeft}
      footerRight={footerRight}
    >
      <ApprovalDetail input={approval.input} />
    </CollapsibleHighlight>
  );
}

// ============================================================================
// Batched approval prompt — react-hook-form, explicit Submit
// ============================================================================

type ApprovalFormValues = Record<string, { approved?: boolean }>;

const approvalsSchema = z.record(
  z.string(),
  z.object({
    approved: z.boolean().optional(),
  }),
);

interface BatchedApprovalPromptProps {
  approvals: PendingApproval[];
  isStreaming: boolean;
  onRespond: (
    approvalId: string,
    approved: boolean,
    reason: string | undefined,
    toolApprovalLevel: ToolApprovalLevel,
  ) => void;
}

function BatchedApprovalPrompt({
  approvals,
  isStreaming,
  onRespond,
}: BatchedApprovalPromptProps) {
  const [preferences] = usePreferences();
  const currentLevel: ToolApprovalLevel =
    preferences.toolApprovalLevel ?? "readonly";

  const defaultValues: ApprovalFormValues = Object.fromEntries(
    approvals.map((a) => [a.approvalId, { approved: undefined }]),
  );

  const decisionForm = useMultiPartDecisionForm<
    PendingApproval,
    ApprovalFormValues
  >({
    parts: approvals,
    partKey: (a) => a.approvalId,
    schema: approvalsSchema,
    defaultValues,
    isStreaming,
    hasAnswer: (v) =>
      typeof (v as { approved?: boolean } | undefined)?.approved === "boolean",
    onSubmit: (approval, value) => {
      const approved = (value as { approved?: boolean })?.approved;
      if (typeof approved !== "boolean") return;
      onRespond(
        approval.approvalId,
        approved,
        approved === false ? DEFAULT_DENY_REASON : undefined,
        currentLevel,
      );
    },
  });

  const fillAndSubmit = () => {
    decisionForm.form.reset(
      Object.fromEntries(
        approvals.map((a) => [a.approvalId, { approved: true }]),
      ) as ApprovalFormValues,
    );
    // submitOrAdvance bypasses the !isStreaming gate — the data-layer
    // deferred-POST check handles in-flight runs.
    decisionForm.submitOrAdvance();
  };

  const current = decisionForm.currentPart;

  return (
    <Form {...decisionForm.form}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          decisionForm.submit();
        }}
      >
        <CollapsibleHighlight
          icon={<ShieldTick size={14} />}
          label={`${approvals.length} approvals pending`}
          title={current?.friendlyName ?? ""}
          defaultExpanded={true}
          footerLeft={
            <PaginatedFormFooterLeft
              currentIndex={decisionForm.currentIndex}
              total={approvals.length}
              onPrev={decisionForm.goPrev}
              onNext={decisionForm.goNext}
              extraLeft={<ApprovalLevelSelect onYolo={fillAndSubmit} />}
            />
          }
          footerRight={
            current ? (
              <ApprovalDecisionButtons
                approvalId={current.approvalId}
                control={decisionForm.form.control}
                onChange={decisionForm.submitOrAdvance}
              />
            ) : null
          }
        >
          {current ? <ApprovalDetail input={current.input} /> : null}
        </CollapsibleHighlight>
      </form>
    </Form>
  );
}

// ============================================================================
// ApprovalDecisionButtons — Deny / Accept pair for the current approval,
// driven by react-hook-form. Click toggles the form value; both buttons can
// be flipped freely before final Submit.
// ============================================================================

function ApprovalDecisionButtons({
  approvalId,
  control,
  onChange,
}: {
  approvalId: string;
  control: Control<ApprovalFormValues>;
  onChange: () => void;
}) {
  return (
    <Controller
      control={control}
      name={`${approvalId}.approved`}
      render={({ field }) => {
        const isAccepted = field.value === true;
        const isDenied = field.value === false;
        return (
          <>
            <Button
              type="button"
              variant={isDenied ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => {
                field.onChange(false);
                onChange();
              }}
              aria-pressed={isDenied}
            >
              Deny
            </Button>
            <Button
              type="button"
              variant={isAccepted ? "default" : "outline"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => {
                field.onChange(true);
                onChange();
              }}
              aria-pressed={isAccepted}
            >
              Accept
            </Button>
          </>
        );
      }}
    />
  );
}

// ============================================================================
// ApprovalLoadingUI
// ============================================================================

function ApprovalLoadingUI() {
  return (
    <div className="flex items-center gap-2 p-4 border border-dashed rounded-lg bg-accent/50 w-[calc(100%-16px)] max-w-[640px] mx-auto mb-2">
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
  onRespond: (
    approvalId: string,
    approved: boolean,
    reason: string | undefined,
    toolApprovalLevel: ToolApprovalLevel,
  ) => void;
}) {
  if (isStreaming && approvals.length === 0) {
    return <ApprovalLoadingUI />;
  }

  if (approvals.length === 0) {
    return null;
  }

  if (approvals.length === 1) {
    const only = approvals[0];
    if (!only) return null;
    return <SingleApprovalPrompt approval={only} onRespond={onRespond} />;
  }

  return (
    <BatchedApprovalPrompt
      approvals={approvals}
      isStreaming={isStreaming}
      onRespond={onRespond}
    />
  );
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
        friendlyName: toTitleCase(stripMcpServerPrefix(toolName)),
        input: part.input,
      });
    }
  }
  return result;
}
