import { Button } from "@deco/ui/components/button.tsx";
import { AlertCircle, AlertTriangle, Copy01 } from "@untitledui/icons";
import { toast } from "sonner";
import {
  readToolApprovalLevel,
  usePreferences,
  type ToolApprovalLevel,
} from "@/web/hooks/use-preferences.ts";
import { useChatPrefs, useChatStream, useChatTask } from "../context";
import type { RequestOptions } from "../store/thread-connection";
import { ApprovalHighlight, extractPendingApprovals } from "./approval";
import { ProposePlanHighlight, extractPendingPlans } from "./propose-plan";
import { UserAskQuestionHighlight } from "./user-ask-question";
import { TodosHighlight } from "./todos";
import { CollapsibleHighlight } from "./collapsible-highlight";
import { CreditsExhaustedBanner } from "../credits-exhausted-banner";
import { useHighlightFlags } from "./use-highlight-count";
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

// Raw error.message strings can be anything: a clean string, an HTML page
// from an upstream proxy (Cloudflare 5xx), a JSON blob, a network failure.
// Classify to pick a human summary + recovery hint; preserve the original
// payload so devs can still inspect it under "Show technical details".
function parseErrorMessage(message: string): {
  summary: string;
  rawDetails: string | null;
} {
  const trimmed = message.trim();
  const looksLikeHtml =
    trimmed.startsWith("<") && /<[a-z][\s\S]*>/i.test(trimmed);
  const isCloudflare =
    /cloudflare|cf-[a-z-]+|error[\s_-]?code[\s_-]?5\d\d/i.test(trimmed);
  const isNetwork = /failed to fetch|networkerror|load failed|offline/i.test(
    trimmed,
  );
  const isTimeout = /timeout|timed out|aborted|deadline/i.test(trimmed);
  const isTooLong = trimmed.length > 240;

  if (isCloudflare || (looksLikeHtml && isTooLong)) {
    return {
      summary:
        "Our servers are having a moment. Try sending again in a few seconds.",
      rawDetails: message,
    };
  }
  if (isNetwork) {
    return {
      summary: "Lost connection. Check your network and try again.",
      rawDetails: message,
    };
  }
  if (isTimeout) {
    return {
      summary: "That took longer than expected. Try again.",
      rawDetails: message,
    };
  }
  if (looksLikeHtml || isTooLong) {
    return {
      summary: "Something unexpected came back from the server. Try again.",
      rawDetails: message,
    };
  }
  return { summary: message, rawDetails: null };
}

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
  const Icon = isError ? AlertCircle : AlertTriangle;

  const rawMessage = isError
    ? props.error.message
    : (WARNING_DESCRIPTIONS[props.finishReason] ??
      `Response stopped unexpectedly: ${props.finishReason}`);

  const { summary, rawDetails } = isError
    ? parseErrorMessage(rawMessage)
    : { summary: rawMessage, rawDetails: null };

  return (
    <CollapsibleHighlight
      icon={<Icon size={14} />}
      label={label}
      title={summary}
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
      {rawDetails ? (
        <details className="group mx-4">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <svg
              aria-hidden="true"
              className="size-3 transition-transform group-open:rotate-90"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m4.5 3 3 3-3 3" />
            </svg>
            <span className="group-open:hidden">Show technical details</span>
            <span className="hidden group-open:inline">
              Hide technical details
            </span>
          </summary>
          <div className="relative mt-2">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(rawDetails)
                  .then(() => toast.success("Copied to clipboard"))
                  .catch(() => toast.error("Could not copy"));
              }}
              aria-label="Copy error details"
              title="Copy"
              className="absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground backdrop-blur-sm transition-colors hover:bg-background hover:text-foreground"
            >
              <Copy01 className="size-3.5" />
            </button>
            <pre className="max-h-40 overflow-auto rounded-md border border-border/60 bg-background px-3 py-2 pr-8 font-mono text-xs text-foreground/80 whitespace-pre-wrap break-all">
              {rawDetails}
            </pre>
          </div>
        </details>
      ) : null}
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
  const assistantParts =
    lastMessage?.role === "assistant" ? lastMessage.parts : [];

  const userAskParts = assistantParts.filter(
    (part) => part.type === "tool-user_ask",
  );
  const pendingPlans = extractPendingPlans(assistantParts);
  const pendingApprovals = extractPendingApprovals(
    assistantParts as Array<{
      type: string;
      state?: string;
      approval?: { id: string };
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
    }>,
  );

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

  const flags = useHighlightFlags();

  if (flags.isCreditExhausted) {
    return <CreditsExhaustedBanner onDismiss={clearError} />;
  }

  const { showError, showWarning, hasApprovals } = flags;
  const userAskKey = userAskParts.map((p) => p.toolCallId).join("|");
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
      {flags.hasPlans && (
        <ProposePlanHighlight
          key={planKey}
          plans={pendingPlans}
          isStreaming={isStreaming}
          onApprove={handlePlanApprove}
          onDismiss={handlePlanDismiss}
        />
      )}
      {flags.isWaitingForUserInput && (
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
