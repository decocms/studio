import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { track } from "@/lib/posthog-client";
import { useStudioTools } from "@/lib/studio-tools";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";

/**
 * The amount picker every credits dialog shows — currency, three presets, and
 * a custom field that opens a Stripe checkout.
 *
 * One component because there were two, byte for byte: the zero-balance modal
 * and the exhausted-mid-stream modal had their own copies of the presets, the
 * toggle, the mutation and the tracking, under two sets of translation keys
 * holding the same sentences. The only thing that ever differed between them
 * was the `source` they reported.
 */

const PRESETS = {
  usd: [
    { dollars: 10, labelKey: "credits.topUp.starter" },
    { dollars: 20, labelKey: "credits.topUp.popular" },
    { dollars: 100, labelKey: "credits.topUp.bestValue" },
  ],
  brl: [
    { dollars: 50, labelKey: "credits.topUp.starter" },
    { dollars: 100, labelKey: "credits.topUp.popular" },
    { dollars: 500, labelKey: "credits.topUp.bestValue" },
  ],
} as const;

/** Stable across surfaces, so one tier reads as one tier in the funnel. */
const TIER_SLUGS: Record<string, string> = {
  "credits.topUp.starter": "starter",
  "credits.topUp.popular": "popular",
  "credits.topUp.bestValue": "best_value",
};

export function TopUpAmounts({
  source,
  onDone,
}: {
  /** Which surface sent them, for the funnel. */
  source: "empty_state" | "exhausted_banner";
  /** Checkout opened — the caller's cue to close itself. */
  onDone?: () => void;
}) {
  const t = useT();
  const studio = useStudioTools();
  const [preferences] = usePreferences();

  const [currency, setCurrency] = useState<"usd" | "brl">(
    preferences.language === "pt-BR" ? "brl" : "usd",
  );
  const [customAmount, setCustomAmount] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const currencySymbol = currency === "brl" ? "R$" : "$";

  const { mutate: topUp, isPending } = useMutation({
    mutationFn: async (amountCents: number) => {
      const { url } = await studio.call("AI_PROVIDER_TOPUP_URL", {
        providerId: "deco",
        amountCents,
        currency,
      });
      return url;
    },
    onSuccess: (url) => {
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      onDone?.();
    },
    onError: (err) => {
      toast.error(t("credits.topUp.failed", { message: err.message }));
    },
  });

  const buy = (amountCents: number, tierLabel: string) => {
    track("credits_topup_clicked", {
      amount_cents: amountCents,
      currency,
      tier_label: tierLabel,
      source,
    });
    topUp(amountCents);
  };

  const customNum = parseFloat(customAmount);
  const isCustomValid = !isNaN(customNum) && customNum >= 1;

  return (
    <div>
      <div className="mb-4">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={currency}
          onValueChange={(v) => {
            if (v) setCurrency(v as "usd" | "brl");
          }}
        >
          <ToggleGroupItem value="usd" className="h-8 px-3 text-xs">
            USD
          </ToggleGroupItem>
          <ToggleGroupItem value="brl" className="h-8 px-3 text-xs">
            BRL
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        {PRESETS[currency].map(({ dollars, labelKey }) => (
          <button
            key={dollars}
            type="button"
            disabled={isPending}
            onClick={() => buy(dollars * 100, TIER_SLUGS[labelKey] ?? "preset")}
            className={cn(
              "relative flex flex-col items-center gap-1 py-5 rounded-xl border transition-all duration-150 cursor-pointer",
              "disabled:opacity-50 disabled:cursor-wait",
              "border-border hover:border-foreground/20 hover:bg-muted/30",
            )}
          >
            <span className="text-2xl font-semibold tabular-nums text-foreground">
              {currencySymbol}
              {dollars}
            </span>
            <span className="text-xs text-muted-foreground">{t(labelKey)}</span>
          </button>
        ))}
      </div>

      {showCustom ? (
        <div className="flex gap-2 mt-3">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground select-none">
              {currencySymbol}
            </span>
            <Input
              type="number"
              min="1"
              step="1"
              placeholder={t("credits.topUp.customPlaceholder")}
              value={customAmount}
              onChange={(e) => setCustomAmount(e.target.value)}
              className="h-10 text-sm pl-7"
              autoFocus
            />
          </div>
          <Button
            className="h-10"
            disabled={!isCustomValid || isPending}
            onClick={() => buy(Math.round(customNum * 100), "custom")}
          >
            {isPending ? t("credits.topUp.opening") : t("credits.topUp.add")}
          </Button>
        </div>
      ) : (
        <button
          type="button"
          className="w-full mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
          onClick={() => setShowCustom(true)}
        >
          {t("credits.topUp.enterCustom")}
        </button>
      )}
    </div>
  );
}
