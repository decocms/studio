import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { AlertCircle, AlertTriangle, X } from "@untitledui/icons";
import { useChat } from "../context";
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
    sendMessage,
  } = useChat();

  const lastMessage = messages.at(-1);

  const userAskParts =
    lastMessage?.role === "assistant"
      ? lastMessage.parts.filter((part) => part.type === "tool-user_ask")
      : null;

  const isWaitingForUserInput = userAskParts?.filter(
    (p) => p.state !== "output-available",
  )?.length;

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
