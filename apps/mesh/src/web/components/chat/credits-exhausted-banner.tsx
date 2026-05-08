/**
 * Credits Exhausted Dialog — shown as a modal when a streaming error
 * indicates the org has run out of Deco AI Gateway credits.
 *
 * Lets the user top up directly from the dialog with quick-pick amounts,
 * or navigate to settings for full provider management.
 */

import { useEffect, useState } from "react";
import { track } from "@/web/lib/posthog-client";
import { Check } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@deco/ui/components/toggle-group.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@deco/ui/components/dialog.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { useDecoCredits } from "@/web/hooks/use-deco-credits";

/**
 * Detect credit/payment errors.
 * The backend prefixes these with `[CREDITS]` so detection is deterministic.
 */
export function isCreditError(error: Error | null): boolean {
  if (!error) return false;
  return error.message.startsWith("[CREDITS]");
}

const QUICK_AMOUNTS = {
  usd: [
    { dollars: 10, label: "Starter" },
    { dollars: 20, label: "Popular" },
    { dollars: 100, label: "Best value" },
  ],
  brl: [
    { dollars: 50, label: "Starter" },
    { dollars: 100, label: "Popular" },
    { dollars: 500, label: "Best value" },
  ],
} as const;

const BENEFITS = [
  "Access to 100+ AI models",
  "Unified API, no separate keys needed",
  "Pay only for what you use",
] as const;

export function CreditsExhaustedBanner({
  onDismiss,
}: {
  onDismiss?: () => void;
}) {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const { decoKeyId } = useDecoCredits();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const [customAmount, setCustomAmount] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [currency, setCurrency] = useState<"usd" | "brl">("usd");
  const currencySymbol = currency === "brl" ? "R$" : "$";

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    track("credits_exhausted_shown", { organization_id: org.id });
  }, [org.id]);

  const { mutate: topUp, isPending } = useMutation({
    mutationFn: async (amountCents: number) => {
      const result = (await client.callTool({
        name: "AI_PROVIDER_TOPUP_URL",
        arguments: {
          providerId: "deco",
          amountCents,
          currency,
        },
      })) as {
        structuredContent?: { url: string };
        isError?: boolean;
        content?: { text?: string }[];
      };
      if (result?.isError) {
        throw new Error(
          result.content?.[0]?.text ?? "Failed to get top-up URL",
        );
      }
      return result.structuredContent?.url;
    },
    onSuccess: (url) => {
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      onDismiss?.();
    },
    onError: (err) => {
      toast.error(`Top-up failed: ${err.message}`);
    },
  });

  const customNum = parseFloat(customAmount);
  const isCustomValid = !isNaN(customNum) && customNum >= 1;

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
                Top up to keep building
              </DialogTitle>
              <DialogDescription className="mt-1.5 text-sm leading-relaxed">
                Your credits are used up. Add more to continue using AI across
                all your agents.
              </DialogDescription>
            </div>
          </DialogHeader>
        </div>

        {/* Amount selection */}
        {decoKeyId && (
          <div className="px-8 pt-5 pb-6">
            {/* Currency toggle */}
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

            {/* Pricing card */}
            <div className="rounded-xl border border-border p-5">
              <div className="grid grid-cols-3 gap-2.5">
                {QUICK_AMOUNTS[currency].map(({ dollars, label }) => (
                  <button
                    key={dollars}
                    type="button"
                    disabled={isPending}
                    onClick={() => {
                      track("credits_topup_clicked", {
                        amount_cents: dollars * 100,
                        currency,
                        tier_label: label,
                        source: "exhausted_banner",
                      });
                      topUp(dollars * 100);
                    }}
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
                    <span className="text-xs text-muted-foreground">
                      {label}
                    </span>
                  </button>
                ))}
              </div>

              {/* Custom amount */}
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
                      placeholder="50"
                      value={customAmount}
                      onChange={(e) => setCustomAmount(e.target.value)}
                      className="h-10 text-sm pl-7"
                      autoFocus
                    />
                  </div>
                  <Button
                    className="h-10"
                    disabled={!isCustomValid || isPending}
                    onClick={() => {
                      track("credits_topup_clicked", {
                        amount_cents: Math.round(customNum * 100),
                        currency,
                        tier_label: "custom",
                        source: "exhausted_banner",
                      });
                      topUp(Math.round(customNum * 100));
                    }}
                  >
                    {isPending ? "Opening..." : "Add"}
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  className="w-full mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
                  onClick={() => setShowCustom(true)}
                >
                  Enter custom amount
                </button>
              )}
            </div>

            {/* Benefits */}
            <div className="mt-5 rounded-xl bg-muted/25 border border-border/50 p-4 space-y-3">
              {BENEFITS.map((text) => (
                <div key={text} className="flex items-center gap-3">
                  <div className="flex items-center justify-center size-5 rounded-full bg-[hsl(var(--chart-1))]/15 shrink-0">
                    <Check size={12} className="text-[hsl(var(--chart-1))]" />
                  </div>
                  <span className="text-sm text-foreground/80">{text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-8 py-4 border-t border-border bg-muted/30 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
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
            Manage providers
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
