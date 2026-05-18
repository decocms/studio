import { Button } from "@deco/ui/components/button.tsx";
import { AlertCircle, AlertTriangle } from "@untitledui/icons";
import {
  readToolApprovalLevel,
  usePreferences,
  type ToolApprovalLevel,
} from "@/web/hooks/use-preferences.ts";
import { useChatPrefs, useChatStream, useChatTask } from "../context";
import type { RequestOptions } from "../hooks/thread-connection";
import { ApprovalHighlight, extractPendingApprovals } from "./approval";
import { ProposePlanHighlight, extractPendingPlans } from "./propose-plan";
import { UserAskQuestionHighlight } from "./user-ask-question";
import { TodosHighlight } from "./todos";
import { CollapsibleHighlight } from "./collapsible-highlight";
import {
  CreditsExhaustedBanner,
  isCreditError,
} from "../credits-exhausted-banner";
import type { UserAskToolPart } from "../types";

// ============================================================================
// StatusHighlight (error | warning)
// ============================================================================

const WARNING_DESCRIPTIONS: Record<string, string> = {
  length:
    "Response reached the model's output limit. Different models have different limits. Try switching models or asking it to continue.",
  "content-filter": "Response was filtered due to content policy.",
  "tool-calls":
    "Response paused after tool execution to prevent infinite loops and save costs. Click continue to keep working.",
};

type StatusHighlightProps =
  | {
      variant: "error";
      error: Error;
      onFixInChat: () => void;
      onDismiss: () => void;
    }
  | {
      variant: "warning";
      finishReason: string;
      onContinue: () => void;
      onDismiss: () => void;
    };

function StatusHighlight(props: StatusHighlightProps) {
  const { variant, onDismiss } = props;
  const isError = variant === "error";

  const label = isError ? "Error occurred" : "Response incomplete";
  const message = isError
    ? props.error.message
    : (WARNING_DESCRIPTIONS[props.finishReason] ??
      `Response stopped unexpectedly: ${props.finishReason}`);
  const Icon = isError ? AlertCircle : AlertTriangle;

  return (
    <CollapsibleHighlight
      icon={<Icon size={14} />}
      label={label}
      title={message}
      defaultExpanded={true}
      variant={variant}
      onClose={onDismiss}
      footerRight={
        isError ? (
          <Button
            size="sm"
            variant="outline"
            onClick={props.onFixInChat}
            className="h-7 text-xs"
          >
            Fix in chat
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={props.onContinue}
            className="h-7 text-xs"
          >
            Continue
          </Button>
        )
      }
    >
      {null}
    </CollapsibleHighlight>
  );
}

// ============================================================================
// ChatHighlight - main component
// ============================================================================

export function ChatHighlight() {
  const {
    error,
    clearError,
    finishReason,
    clearFinishReason,
    messages,
    isStreaming,
    isWaitingForApprovals,
    submit,
    sendMessage,
  } = useChatStream();
  const [preferences, setPreferences] = usePreferences();
  const { virtualMcpId, createTaskWithMessage } = useChatTask();
  const { chatMode, simpleModeTier } = useChatPrefs();

  // Build a fresh RequestOptions at call time so tier/mode reflect the
  // user's current selection. `toolApprovalLevel` is passed in explicitly:
  // the approval dropdown flips it to "auto" and triggers Accept-All in
  // the same handler, so reading React state here would see the stale
  // pre-change value.
  const buildRequestOptions = (
    toolApprovalLevel: ToolApprovalLevel,
  ): RequestOptions => ({
    tier: simpleModeTier,
    mode: chatMode,
    toolApprovalLevel,
    agent: virtualMcpId ? { id: virtualMcpId } : undefined,
  });

  const currentApprovalLevel: ToolApprovalLevel =
    preferences.toolApprovalLevel ?? readToolApprovalLevel();

  const lastMessage = messages.at(-1);

  const userAskParts =
    lastMessage?.role === "assistant"
      ? lastMessage.parts.filter((part) => part.type === "tool-user_ask")
      : null;

  // Coerce to boolean — `.length` is a number, and concurrent JSX renders
  // `{0 && <X/>}` as the literal text "0" (unlike the prior priority cascade,
  // where `if (0) { return … }` was control flow). After every user_ask
  // resolves to `output-available`, the unfiltered count is 0, which would
  // otherwise stamp a stray "0" between the highlight stack and the input.
  const isWaitingForUserInput = !!userAskParts?.filter(
    (p) => p.state !== "output-available",
  )?.length;

  // Collect pending plan proposals from the last assistant message
  const pendingPlans =
    lastMessage?.role === "assistant"
      ? extractPendingPlans(lastMessage.parts)
      : [];

  // Collect pending approval parts from the last assistant message
  const pendingApprovals =
    lastMessage?.role === "assistant"
      ? extractPendingApprovals(
          lastMessage.parts as Array<{
            type: string;
            state?: string;
            approval?: { id: string };
            toolCallId?: string;
            toolName?: string;
            input?: unknown;
          }>,
        )
      : [];

  const handleFixInChat = () => {
    if (error) {
      const text = `I encountered this error: ${error.message}. Can you help me fix it?`;
      const doc = {
        type: "doc" as const,
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      };
      void sendMessage(doc);
    }
  };

  const handleContinue = () => {
    const doc = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Please continue." }],
        },
      ],
    };
    void sendMessage(doc);
  };

  const handleUserAskSubmit = (part: UserAskToolPart, response: string) => {
    void submit(
      {
        kind: "toolOutput",
        toolCallId: part.toolCallId,
        output: { response },
      },
      buildRequestOptions(currentApprovalLevel),
    );
  };

  const handlePlanApprove = (planText: string) => {
    // Set approval level to auto and persist
    setPreferences({ ...preferences, toolApprovalLevel: "auto" });

    // Send plan to a new thread via sendToChat
    createTaskWithMessage({
      virtualMcpId,
      message: {
        parts: [{ type: "text", text: `Implement this plan:\n\n${planText}` }],
      },
    });
  };

  const handlePlanDismiss = () => {
    const editor = document.querySelector<HTMLElement>("[data-chat-input]");
    editor?.focus();
  };

  const handleApprovalRespond = (
    approvalId: string,
    approved: boolean,
    reason: string | undefined,
    toolApprovalLevel: ToolApprovalLevel,
  ) => {
    void submit(
      {
        kind: "approval",
        approvalId,
        approved,
        ...(reason ? { reason } : {}),
      },
      buildRequestOptions(toolApprovalLevel),
    );
  };

  // Each banner condition is evaluated independently; all that match
  // render. Stack order is severity-descending — the last child sits
  // closest to the chat input. Credit-exhausted errors are a modal,
  // handled by an early return outside the stack.

  if (!isStreaming && error && isCreditError(error)) {
    return <CreditsExhaustedBanner onDismiss={clearError} />;
  }

  const showError = !isStreaming && !!error;
  const hasApprovals =
    pendingApprovals.length > 0 || (isStreaming && isWaitingForApprovals);
  // `user_ask` and `propose_plan` are client-side tools (no `execute`), so
  // the model emitting one terminates the step loop with
  // `finishReason: "tool-calls"`. Same for tools paused on
  // `approval-requested`. Those are expected handoffs, not stuck loops —
  // the matching cards (UserAskQuestion / ProposePlan / Approval) already
  // tell the user what to do, so suppress the duplicate warning. Mirrors
  // the backend's `resolveThreadStatus` (status.ts) which maps the same
  // shape to `requires_action`.
  const isToolCallsWaitingOnClient =
    finishReason === "tool-calls" &&
    (isWaitingForUserInput || hasApprovals || pendingPlans.length > 0);
  const showWarning =
    !isStreaming &&
    !!finishReason &&
    finishReason !== "stop" &&
    !isToolCallsWaitingOnClient &&
    !showError;
  const userAskKey = userAskParts?.map((p) => p.toolCallId).join("|") ?? "";
  const planKey = pendingPlans[0]?.toolCallId ?? "";
  const approvalKey = pendingApprovals.map((a) => a.approvalId).join("|");

  return (
    <div className="absolute bottom-full left-0 right-0">
      <TodosHighlight />
      {showError && (
        <StatusHighlight
          variant="error"
          error={error as Error}
          onDismiss={clearError}
          onFixInChat={handleFixInChat}
        />
      )}
      {showWarning && (
        <StatusHighlight
          variant="warning"
          finishReason={finishReason as string}
          onDismiss={clearFinishReason}
          onContinue={handleContinue}
        />
      )}
      {hasApprovals && (
        <ApprovalHighlight
          key={approvalKey}
          approvals={pendingApprovals}
          isStreaming={isStreaming}
          onRespond={handleApprovalRespond}
        />
      )}
      {pendingPlans.length > 0 && (
        <ProposePlanHighlight
          key={planKey}
          plans={pendingPlans}
          isStreaming={isStreaming}
          onApprove={handlePlanApprove}
          onDismiss={handlePlanDismiss}
        />
      )}
      {isWaitingForUserInput && userAskParts && (
        <UserAskQuestionHighlight
          key={userAskKey}
          userAskParts={userAskParts}
          isStreaming={isStreaming}
          onSubmit={handleUserAskSubmit}
        />
      )}
    </div>
  );
}

ChatHighlight.Error = function ErrorHighlight(props: {
  error: Error;
  onDismiss: () => void;
  onFixInChat: () => void;
}) {
  return (
    <StatusHighlight
      variant="error"
      error={props.error}
      onDismiss={props.onDismiss}
      onFixInChat={props.onFixInChat}
    />
  );
};
ChatHighlight.Warning = function WarningHighlight(props: {
  finishReason: string;
  onDismiss: () => void;
  onContinue: () => void;
}) {
  return (
    <StatusHighlight
      variant="warning"
      finishReason={props.finishReason}
      onDismiss={props.onDismiss}
      onContinue={props.onContinue}
    />
  );
};
ChatHighlight.UserAskQuestion = UserAskQuestionHighlight;
