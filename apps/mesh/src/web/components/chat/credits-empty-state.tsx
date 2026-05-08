/**
 * Credits Empty State — dismissable modal shown once when a user enters
 * a new org that has a Deco AI Gateway key but zero credits (the $2
 * was already claimed on another org).
 *
 * Once dismissed (or after adding credits), stores a flag in localStorage
 * so it doesn't reappear. The normal home page renders underneath.
 */

import { useEffect, useState } from "react";
import { track } from "@/web/lib/posthog-client";
import { Coins04, ArrowRight } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
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
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const { decoKeyId } = useDecoCredits();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const [open, setOpen] = useState(true);
  const [customAmount, setCustomAmount] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [currency, setCurrency] = useState<"usd" | "brl">("usd");
  const currencySymbol = currency === "brl" ? "R$" : "$";

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
      dismiss();
    },
    onError: (err) => {
      toast.error(`Top-up failed: ${err.message}`);
    },
  });

  const customNum = parseFloat(customAmount);
  const isCustomValid = !isNaN(customNum) && customNum >= 1;

  if (!open) return null;

  return (
    <Dialog open onOpenChange={(v) => !v && dismiss()}>
      <DialogContent
        className="sm:max-w-[500px] gap-0 p-0 overflow-hidden"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* Header */}
        <div className="relative px-6 pt-7 pb-5">
          <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-amber-500/8 to-transparent pointer-events-none rounded-t-lg" />
          <DialogHeader className="relative gap-3">
            <div className="flex items-center justify-center size-11 rounded-full bg-amber-100 dark:bg-amber-900/40 border border-amber-200/60 dark:border-amber-800/40 mx-auto">
              <Coins04
                size={20}
                className="text-amber-600 dark:text-amber-400"
              />
            </div>
            <div className="text-center">
              <DialogTitle className="text-lg font-semibold">
                This workspace has no credits
              </DialogTitle>
              <DialogDescription className="mt-2 text-[13px] leading-relaxed max-w-[320px] mx-auto">
                Your free credits were used in another workspace. Add credits to
                use AI here.
              </DialogDescription>
            </div>
          </DialogHeader>
        </div>

        {/* Amount selection — clicking a preset fires checkout directly */}
        {decoKeyId && (
          <div className="px-6 pb-5">
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
                      source: "empty_state",
                    });
                    topUp(dollars * 100);
                  }}
                  className={cn(
                    "relative flex flex-col items-center gap-1 py-6 rounded-xl border transition-all duration-150 cursor-pointer",
                    "disabled:opacity-50 disabled:cursor-wait",
                    "border-border hover:border-foreground/20 hover:bg-muted/30",
                  )}
                >
                  <span className="text-2xl font-semibold tabular-nums text-foreground">
                    {currencySymbol}
                    {dollars}
                  </span>
                  <span className="text-xs text-muted-foreground">{label}</span>
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
                      source: "empty_state",
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
                className="w-full mt-2.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
                onClick={() => setShowCustom(true)}
              >
                Enter custom amount
              </button>
            )}
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
            Use your own provider
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
            Skip for now
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
