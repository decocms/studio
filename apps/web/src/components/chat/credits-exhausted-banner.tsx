/**
 * Credits Exhausted Dialog — shown as a modal when a streaming error
 * indicates the org has run out of Deco AI Gateway credits.
 *
 * Lets the user top up directly from the dialog with quick-pick amounts,
 * or navigate to settings for full provider management.
 */

import { useEffect } from "react";
import { track } from "@/lib/posthog-client";
import { Check } from "@untitledui/icons";
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
import { useT } from "@/i18n/use-t";
import { TopUpAmounts } from "@/components/credits/top-up-amounts";

const BENEFITS_KEYS = [
  "chat.creditsExhaustedBanner.benefit1",
  "chat.creditsExhaustedBanner.benefit2",
  "chat.creditsExhaustedBanner.benefit3",
] as const;

export function CreditsExhaustedBanner({
  onDismiss,
}: {
  onDismiss?: () => void;
}) {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const { decoKeyId } = useDecoCredits();
  const t = useT();
  /**
   * A plan without the `credits` feature cannot top up: `AI_PROVIDER_TOPUP_URL`
   * declares `requiresFeature: "credits"`, so every amount on this surface
   * would return `403 feature_not_in_plan`. Every plan has it today, Free
   * included; an org can still have it revoked. The caller in
   * `highlight/index.tsx` checks the same gate and shows the plan refusal
   * instead, so returning null here is never the org's whole answer. Fails
   * OPEN like every other access gate, so a gateway blip still lets an org
   * that CAN pay, pay.
   */
  const canBuyCredits = useFeature("credits");

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    track("credits_exhausted_shown", { organization_id: org.id });
  }, [org.id]);

  if (!canBuyCredits) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onDismiss?.()}>
      <DialogContent
        className="sm:max-w-[520px] gap-0 p-0 overflow-hidden"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* Header with deco gradient fade */}
        <div className="relative px-8 pt-8 pb-2 overflow-hidden">
          <div
            className="absolute inset-x-0 top-0 h-36 pointer-events-none"
            style={{
              backgroundImage: [
                "radial-gradient(ellipse 40% 200% at -5% 100%, rgba(165,149,255,0.5) 0%, transparent 100%)",
                "radial-gradient(ellipse 40% 200% at 105% -10%, rgba(208,236,26,0.45) 0%, transparent 100%)",
              ].join(", "),
              maskImage:
                "linear-gradient(to bottom, black 0%, transparent 100%)",
              WebkitMaskImage:
                "linear-gradient(to bottom, black 0%, transparent 100%)",
            }}
          />
          <DialogHeader className="relative gap-4">
            <img
              src="/logos/deco%20logo.svg"
              alt="Deco AI Gateway"
              className="size-9 rounded-lg object-contain dark:bg-white dark:p-0.5"
            />
            <div>
              <DialogTitle className="text-xl font-semibold tracking-tight">
                {t("chat.creditsExhaustedBanner.title")}
              </DialogTitle>
              <DialogDescription className="mt-1.5 text-sm leading-relaxed">
                {t("chat.creditsExhaustedBanner.description")}
              </DialogDescription>
            </div>
          </DialogHeader>
        </div>

        {/* Amount selection */}
        {decoKeyId && (
          <div className="px-8 pt-5 pb-6">
            <div className="rounded-xl border border-border p-5">
              <TopUpAmounts source="exhausted_banner" onDone={onDismiss} />
            </div>

            {/* Benefits */}
            <div className="mt-5 rounded-xl bg-muted/25 border border-border/50 p-4 space-y-3">
              {BENEFITS_KEYS.map((key) => (
                <div key={key} className="flex items-center gap-3">
                  <div className="flex items-center justify-center size-5 rounded-full bg-success/15 shrink-0">
                    <Check size={12} className="text-success" />
                  </div>
                  <span className="text-sm text-foreground/80">{t(key)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-8 py-4 border-t border-border bg-muted/30 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            {t("chat.creditsExhaustedBanner.dismiss")}
          </Button>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => {
              navigate({
                to: "/$org/settings/ai-providers",
                params: { org: org.slug },
              });
              onDismiss?.();
            }}
          >
            {t("chat.creditsExhaustedBanner.manageProviders")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
