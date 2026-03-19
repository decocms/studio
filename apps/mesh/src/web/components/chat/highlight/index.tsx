import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { AlertCircle, AlertTriangle, X } from "@untitledui/icons";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { useChat } from "../context";
import { chatStore } from "../store/chat-store";
import { ApprovalHighlight, extractPendingApprovals } from "./approval";
import { ProposePlanHighlight, extractPendingPlans } from "./propose-plan";
import { UserAskQuestionHighlight } from "./user-ask-question";
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

  const title = isError ? "Error occurred" : "Response incomplete";
  const description = isError
    ? props.error.message
    : (WARNING_DESCRIPTIONS[props.finishReason] ??
      `Response stopped unexpectedly: ${props.finishReason}`);

  const variantStyles = isError
    ? "border-destructive/30 bg-destructive/5"
    : "border-amber-500/30 bg-amber-500/5";
  const iconStyles = isError
    ? "text-destructive"
    : "text-amber-600 dark:text-amber-500";
  const Icon = isError ? AlertCircle : AlertTriangle;

  return (
    <div className="px-0.5">
      <div
        className={cn(
          "flex items-start gap-2 px-3 py-2.5 rounded-lg border border-dashed text-sm w-full mb-2 shadow",
          variantStyles,
        )}
      >
        <div className={cn("mt-0.5 shrink-0", iconStyles)}>
          <Icon size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className={cn("text-xs mb-1 font-medium", iconStyles)}>
            {title}
          </div>
          <div className="text-xs line-clamp-2 text-muted-foreground mb-2">
            {description}
          </div>
          <div className="flex gap-2">
            {isError ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={props.onFixInChat}
                  className="h-7 text-xs"
                >
                  Fix in chat
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled
                  className="h-7 text-xs"
                >
                  Report
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={props.onContinue}
                className="h-7 text-xs"
              >
                Continue
              </Button>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    </div>
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
    addToolOutput,
    addToolApprovalResponse,
    sendMessage,
  } = useChat();
  const [preferences, setPreferences] = usePreferences();

  const lastMessage = messages.at(-1);

  const userAskParts =
    lastMessage?.role === "assistant"
      ? lastMessage.parts.filter((part) => part.type === "tool-user_ask")
      : null;

  const isWaitingForUserInput = userAskParts?.filter(
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
    addToolOutput({
      tool: "user_ask",
      toolCallId: part.toolCallId,
      output: { response },
    });
  };

  const handlePlanApprove = (planText: string) => {
    // Set approval level to auto and persist
    chatStore.setToolApprovalLevel("auto");
    setPreferences({ ...preferences, toolApprovalLevel: "auto" });

    // Create a new thread and queue the plan as the initial message.
    // createThreadAndSend() stores the message and drains it once
    // ChatBridge re-registers with the fresh Chat instance, avoiding
    // the race where sendMessage() would use the old bridge methods.
    chatStore.createThreadAndSend({
      parts: [{ type: "text", text: `Implement this plan:\n\n${planText}` }],
      toolApprovalLevel: "auto",
    });
  };

  const handlePlanDismiss = () => {
    const editor = document.querySelector<HTMLElement>("[data-chat-input]");
    editor?.focus();
  };

  const handleApprovalRespond = (
    approvalId: string,
    approved: boolean,
    reason?: string,
  ) => {
    addToolApprovalResponse({
      id: approvalId,
      approved,
      ...(reason ? { reason } : {}),
    });
  };

  // Priority: user_ask > propose_plan > approval > error > warning
  if (isWaitingForUserInput) {
    return (
      <div className="absolute bottom-full left-0 right-0">
        <UserAskQuestionHighlight
          userAskParts={userAskParts}
          isStreaming={isStreaming}
          onSubmit={handleUserAskSubmit}
        />
      </div>
    );
  }

  if (pendingPlans.length > 0) {
    return (
      <div className="absolute bottom-full left-0 right-0">
        <ProposePlanHighlight
          plans={pendingPlans}
          isStreaming={isStreaming}
          onApprove={handlePlanApprove}
          onDismiss={handlePlanDismiss}
        />
      </div>
    );
  }

  if (pendingApprovals.length > 0 || (isStreaming && isWaitingForApprovals)) {
    return (
      <div className="absolute bottom-full left-0 right-0">
        <ApprovalHighlight
          approvals={pendingApprovals}
          isStreaming={isStreaming}
          onRespond={handleApprovalRespond}
        />
      </div>
    );
  }

  if (!isStreaming && error) {
    return (
      <div className="absolute bottom-full left-0 right-0 bg-background">
        <StatusHighlight
          variant="error"
          error={error}
          onDismiss={clearError}
          onFixInChat={handleFixInChat}
        />
      </div>
    );
  }

  if (
    !isStreaming &&
    finishReason &&
    finishReason !== "stop" &&
    !isWaitingForApprovals
  ) {
    return (
      <div className="absolute bottom-full left-0 right-0 bg-background">
        <StatusHighlight
          variant="warning"
          finishReason={finishReason}
          onDismiss={clearFinishReason}
          onContinue={handleContinue}
        />
      </div>
    );
  }

  return null;
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
