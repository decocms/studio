"use client";

import { Button } from "@deco/ui/components/button.tsx";
import { Check, ClipboardCheck } from "@untitledui/icons";
import { CollapsibleHighlight } from "./collapsible-highlight";
import { MessageTextPart } from "../message/parts/text-part.tsx";
import { selectActivePlan, type PendingPlan } from "./extract-pending-plans";
import { useT } from "@/web/i18n/use-t.ts";
export {
  extractPendingPlans,
  selectActivePlan,
  type PendingPlan,
} from "./extract-pending-plans";

// ============================================================================
// ProposePlanPrompt - Plan card with approve/reject buttons
// ============================================================================

interface ProposePlanPromptProps {
  plan: PendingPlan;
  onApprove: (planText: string) => void;
  onDismiss: () => void;
}

function ProposePlanPrompt({
  plan,
  onApprove,
  onDismiss,
}: ProposePlanPromptProps) {
  const t = useT();
  const handleApprove = () => {
    onApprove(plan.plan);
  };

  const footerRight = (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2.5 text-xs text-muted-foreground [@media(hover:hover)]:hover:text-foreground active:scale-[0.97] transition-transform"
        onClick={onDismiss}
      >
        {t("chat.proposePlan.keepIterating")}
      </Button>
      <Button
        type="button"
        size="sm"
        className="h-7 px-2.5 text-xs bg-purple-600 hover:bg-purple-700 text-white active:scale-[0.97] transition-transform"
        onClick={handleApprove}
      >
        {t("chat.proposePlan.letsGo")}
      </Button>
    </>
  );

  return (
    <CollapsibleHighlight
      icon={<ClipboardCheck size={14} />}
      label={t("chat.proposePlan.planReady")}
      title={t("chat.proposePlan.implementationPlan")}
      defaultExpanded={true}
      footerRight={footerRight}
    >
      <div className="px-4 max-h-64 overflow-y-auto">
        <div className="prose prose-sm max-w-none text-sm">
          <MessageTextPart
            id="plan-preview"
            part={{ type: "text", text: plan.plan }}
          />
        </div>
      </div>
    </CollapsibleHighlight>
  );
}

// ============================================================================
// ProposePlanLoadingUI
// ============================================================================

function ProposePlanLoadingUI() {
  const t = useT();
  return (
    <div className="flex items-center gap-2 p-4 border border-dashed border-purple-500/30 rounded-lg bg-purple-500/5 w-[calc(100%-16px)] max-w-[640px] mx-auto mb-2">
      <Check className="size-5 text-purple-500 shimmer" />
      <span className="text-sm text-muted-foreground shimmer">
        {t("chat.proposePlan.preparingPlan")}
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
  onApprove,
  onDismiss,
}: {
  plans: PendingPlan[];
  isStreaming: boolean;
  onApprove: (planText: string) => void;
  onDismiss: () => void;
}) {
  if (isStreaming && plans.length === 0) {
    return <ProposePlanLoadingUI />;
  }

  // Show only the last pending plan
  const activePlan = selectActivePlan(plans);
  if (!activePlan) {
    return null;
  }

  return (
    <ProposePlanPrompt
      plan={activePlan}
      onApprove={onApprove}
      onDismiss={onDismiss}
    />
  );
}
