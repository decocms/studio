import { Button } from "@deco/ui/components/button.tsx";
import { AlertCircle, AlertTriangle, Copy01 } from "@untitledui/icons";
import { toast } from "sonner";
import {
  readToolApprovalLevel,
  usePreferences,
  type ToolApprovalLevel,
} from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/en/index.ts";
import { useChatPrefs, useChatStream, useChatTask } from "../context";
import type { RequestOptions } from "../store/thread-connection";
import { ApprovalHighlight, extractPendingApprovals } from "./approval";
import {
  ProposePlanHighlight,
  extractPendingPlans,
  selectActivePlan,
} from "./propose-plan";
import { UserAskQuestionHighlight } from "./user-ask-question";
import { TodosHighlight } from "./todos";
import { CollapsibleHighlight } from "./collapsible-highlight";
import { CreditsExhaustedBanner } from "../credits-exhausted-banner";
import { useHighlightFlags } from "./use-highlight-count";
import { parseErrorMessage } from "./parse-error-message";
import type { UserAskToolPart } from "../types";

// ============================================================================
// StatusHighlight (error | warning)
// ============================================================================

const WARNING_DESCRIPTIONS = {
  length: "chat.highlight.warningDescriptionLength",
  "content-filter": "chat.highlight.warningDescriptionContentFilter",
  "tool-calls": "chat.highlight.warningDescriptionToolCalls",
} as const satisfies Record<string, TranslationKey>;

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
  const t = useT();
  const { variant, onDismiss } = props;
  const isError = variant === "error";

  const label = isError
    ? t("chat.highlight.errorOccurred")
    : t("chat.highlight.responseIncomplete");
  const Icon = isError ? AlertCircle : AlertTriangle;

  const rawMessage =
    props.variant === "error"
      ? props.error.message
      : (() => {
          const warningDescriptionKey =
            WARNING_DESCRIPTIONS[
              props.finishReason as keyof typeof WARNING_DESCRIPTIONS
            ];
          return warningDescriptionKey
            ? t(warningDescriptionKey)
            : t("chat.highlight.responseStoppedUnexpectedly", {
                reason: props.finishReason,
              });
        })();

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
            {t("chat.highlight.fixInChat")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={props.onContinue}
            className="h-7 text-xs"
          >
            {t("chat.highlight.continue")}
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
            <span className="group-open:hidden">
              {t("chat.highlight.showTechnicalDetails")}
            </span>
            <span className="hidden group-open:inline">
              {t("chat.highlight.hideTechnicalDetails")}
            </span>
          </summary>
          <div className="relative mt-2">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(rawDetails)
                  .then(() =>
                    toast.success(t("chat.highlight.copiedToClipboard")),
                  )
                  .catch(() => toast.error(t("chat.highlight.couldNotCopy")));
              }}
              aria-label={t("chat.highlight.copyErrorDetails")}
              title={t("chat.highlight.copy")}
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
  const t = useT();
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
      const text = t("chat.highlight.fixInChatMessage", {
        error: error.message,
      });
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
          content: [{ type: "text", text: t("chat.highlight.pleaseContinue") }],
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
        parts: [
          {
            type: "text",
            text: t("chat.highlight.implementPlanMessage", { plan: planText }),
          },
        ],
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
  const planKey = selectActivePlan(pendingPlans)?.toolCallId ?? "";
  const approvalKey = pendingApprovals.map((a) => a.approvalId).join("|");

  return (
    <div className="absolute bottom-full left-0 right-0">
      <TodosHighlight todos={flags.todos} />
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
