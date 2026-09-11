/**
 * Inline card for a turn the PLAN refused — the org's AI allowance is spent,
 * or its plan does not include chat.
 *
 * The composer gates both already (`useAiBudgetExhausted`, `useFeature`), so
 * this only fires when the client's answer was stale: entitlements are cached
 * for a minute, and the turn that EXHAUSTS the bar is by definition sent while
 * the bar still read ok. Without it that turn came back as a raw error blob,
 * which is the one moment the user most needs to be told what to buy.
 */
import { Lightning01 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@decocms/ui/components/button.tsx";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import type { PlanRefusalKind } from "../chat-post-error";
import { CollapsibleHighlight } from "./collapsible-highlight";

const COPY_KEYS = {
  ai_budget_exhausted: {
    label: "chat.planRefused.budgetLabel",
    title: "chat.planRefused.budgetTitle",
  },
  feature_not_in_plan: {
    label: "chat.planRefused.featureLabel",
    title: "chat.planRefused.featureTitle",
  },
} as const satisfies Record<PlanRefusalKind, { label: string; title: string }>;

export function PlanRefusedHighlight({
  kind,
  onDismiss,
}: {
  kind: PlanRefusalKind;
  onDismiss: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
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
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            // The plan picker, not a Stripe checkout: which plan to buy is the
            // org's choice, and the same place `FeaturePaywall` sends them.
            navigate({
              to: "/$org/settings/ai-providers",
              params: { org: org.slug },
            });
            onDismiss();
          }}
        >
          {t("chat.planRefused.seePlans")}
        </Button>
      }
    />
  );
}
