/**
 * Inline card for a `[SUBSCRIPTION_REQUIRED]` run error — e.g. a reviewer
 * thread's `TASK_BOARD_REVIEW_DECISION` bounce-back to the Super Agent hit
 * the org's or the task's auto-task quota. Deliberately NOT the sales
 * paywall modal (`SubscriptionPaywallDialog`) used for a user-initiated
 * delegation: this is an automated review flow, so it stays a quiet inline
 * card. Only the trial-exhausted case gets a "Subscribe" action — the other
 * two are informational (it resolves on its own next cycle, or needs a new
 * task).
 */
import { Lightning01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { SubscriptionErrorKind } from "@/components/task-board/is-subscription-error";
import { CollapsibleHighlight } from "./collapsible-highlight";

const COPY_KEYS = {
  trial_exhausted: {
    label: "chat.subscriptionLimit.trialLabel",
    title: "chat.subscriptionLimit.trialTitle",
  },
  monthly_exhausted: {
    label: "chat.subscriptionLimit.monthlyLabel",
    title: "chat.subscriptionLimit.monthlyTitle",
  },
  runs_exhausted: {
    label: "chat.subscriptionLimit.runsLabel",
    title: "chat.subscriptionLimit.runsTitle",
  },
} as const satisfies Record<
  SubscriptionErrorKind,
  { label: string; title: string }
>;

export function SubscriptionLimitHighlight({
  kind,
  onDismiss,
  onSubscribe,
}: {
  kind: SubscriptionErrorKind;
  onDismiss: () => void;
  onSubscribe: () => void;
}) {
  const t = useT();
  const { label, title } = COPY_KEYS[kind];

  return (
    <CollapsibleHighlight
      icon={<Lightning01 size={14} />}
      label={t(label)}
      title={t(title)}
      defaultExpanded={true}
      variant="warning"
      onClose={onDismiss}
      footerRight={
        kind === "trial_exhausted" ? (
          <Button size="sm" onClick={onSubscribe} className="h-7 text-xs">
            {t("chat.subscriptionLimit.subscribeButton")}
          </Button>
        ) : undefined
      }
    />
  );
}
