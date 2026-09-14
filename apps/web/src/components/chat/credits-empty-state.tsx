/**
 * Credits Empty State — dismissable modal shown once when a user enters
 * a new org that has a Deco AI Gateway key but zero credits (the $2
 * was already claimed on another org).
 *
 * Once dismissed (or after adding credits), stores a flag in localStorage
 * so it doesn't reappear. The normal home page renders underneath.
 */

import { useEffect, useState } from "react";
import { track } from "@/lib/posthog-client";
import { Coins04, ArrowRight } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@decocms/ui/components/dialog.tsx";
import { useFeature } from "@/hooks/use-entitlements";
import { useProjectContext } from "@/sdk";
import { useNavigate } from "@tanstack/react-router";
import { useDecoCredits } from "@/hooks/use-deco-credits";
import { useT } from "@/i18n/use-t.ts";
import { FeaturePaywall } from "@/components/feature-paywall";
import { TopUpAmounts } from "@/components/credits/top-up-amounts";

function dismissKeyForOrg(orgId: string): string {
  return `deco-credits-empty-dismissed:${orgId}`;
}

/** Returns true if the zero-credits modal was already dismissed for this org. */
export function wasCreditsEmptyDismissed(orgId: string): boolean {
  try {
    return localStorage.getItem(dismissKeyForOrg(orgId)) === "1";
  } catch {
    return false;
  }
}

export function CreditsEmptyState() {
  const t = useT();
  const { org } = useProjectContext();
  /**
   * A plan without the `credits` feature cannot top up: `AI_PROVIDER_TOPUP_URL`
   * declares `requiresFeature: "credits"`, which Free does not have, so every
   * amount on this surface returns `403 feature_not_in_plan`. Such an org gets
   * the plan dialog instead of this one, NOT nothing: this modal fires exactly
   * when an org opens a chat it has no way to run, which is the moment it most
   * needs to be told why. Fails OPEN like every other access gate, so a gateway
   * blip still lets an org that CAN pay, pay.
   */
  const canBuyCredits = useFeature("credits");

  const navigate = useNavigate();
  const { decoKeyId } = useDecoCredits();

  const [open, setOpen] = useState(true);

  const dismiss = () => {
    track("credits_empty_state_dismissed", { organization_id: org.id });
    setOpen(false);
    try {
      localStorage.setItem(dismissKeyForOrg(org.id), "1");
    } catch {
      // localStorage unavailable
    }
  };

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (open) {
      track("credits_empty_state_shown", { organization_id: org.id });
    }
  }, [open, org.id]);

  if (!open) return null;

  if (!canBuyCredits) {
    return (
      <FeaturePaywall
        feature="chat"
        copy={{ title: t("chat.input.allowanceExhaustedTitle") }}
        onDismiss={dismiss}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(v) => !v && dismiss()}>
      <DialogContent
        className="sm:max-w-[500px] gap-0 p-0 overflow-hidden"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* Header */}
        <div className="relative px-6 pt-7 pb-5">
          <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-warning/8 to-transparent pointer-events-none rounded-t-lg" />
          <DialogHeader className="relative gap-3">
            <div className="flex items-center justify-center size-11 rounded-full bg-warning/10 border border-warning/20 mx-auto">
              <Coins04 size={20} className="text-warning" />
            </div>
            <div className="text-center">
              <DialogTitle className="text-lg font-semibold">
                {t("chat.creditsEmptyState.title")}
              </DialogTitle>
              <DialogDescription className="mt-2 text-[13px] leading-relaxed max-w-[320px] mx-auto">
                {t("chat.creditsEmptyState.description")}
              </DialogDescription>
            </div>
          </DialogHeader>
        </div>

        {/* Amount selection — clicking a preset fires checkout directly */}
        {decoKeyId && (
          <div className="px-6 pb-5">
            <TopUpAmounts source="empty_state" onDone={dismiss} />
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-border bg-muted/30 flex items-center justify-between">
          <button
            type="button"
            className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => {
              navigate({
                to: "/$org/settings/ai-providers",
                params: { org: org.slug },
              });
              dismiss();
            }}
          >
            {t("chat.creditsEmptyState.useYourOwnProvider")}
            <ArrowRight
              size={12}
              className="transition-transform duration-150 group-hover:translate-x-0.5"
            />
          </button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={dismiss}
          >
            {t("chat.creditsEmptyState.skipForNow")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
