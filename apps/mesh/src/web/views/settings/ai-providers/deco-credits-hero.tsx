import { useState } from "react";
import { useQueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { RefreshCw01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  SettingsCard,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import { Input } from "@deco/ui/components/input.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@deco/ui/components/toggle-group.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { cn } from "@deco/ui/lib/utils.ts";

// ── Quick Top-Up presets ──────────────────────────────────────────────

const TOP_UP_PRESETS = {
  usd: [10, 20, 100],
  brl: [50, 100, 500],
} as const;

function QuickTopUp() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const [customOpen, setCustomOpen] = useState(false);

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
    },
    onError: (err) => {
      toast.error(`Top-up failed: ${err.message}`);
    },
  });

  const [customAmount, setCustomAmount] = useState("");
  const [currency, setCurrency] = useState<"usd" | "brl">("usd");
  const customNum = parseFloat(customAmount);
  const isCustomValid = !isNaN(customNum) && customNum >= 1;
  const currencySymbol = currency === "brl" ? "R$" : "$";

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="default"
          value={currency}
          onValueChange={(v) => {
            if (v) setCurrency(v as "usd" | "brl");
          }}
        >
          <ToggleGroupItem value="usd" className="px-3.5 text-sm">
            USD
          </ToggleGroupItem>
          <ToggleGroupItem value="brl" className="px-3.5 text-sm">
            BRL
          </ToggleGroupItem>
        </ToggleGroup>
        {!customOpen && (
          <>
            {TOP_UP_PRESETS[currency].map((dollars) => (
              <Button
                key={dollars}
                variant="outline"
                className="h-10 px-4 text-sm font-medium tabular-nums"
                disabled={isPending}
                onClick={() => topUp(dollars * 100)}
              >
                {currencySymbol}
                {dollars}
              </Button>
            ))}
            <Button
              variant="ghost"
              className="h-10 px-4 text-sm text-muted-foreground"
              onClick={() => setCustomOpen(true)}
              disabled={isPending}
            >
              Custom
            </Button>
          </>
        )}
        {customOpen && (
          <>
            <div className="relative max-w-[140px]">
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
              onClick={() => topUp(Math.round(customNum * 100))}
            >
              {isPending ? "..." : "Add"}
            </Button>
            <Button
              variant="ghost"
              className="h-10 text-sm text-muted-foreground"
              onClick={() => {
                setCustomOpen(false);
                setCustomAmount("");
              }}
            >
              Cancel
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Deco Credits Hero ────────────────────────────────────────────────

function creditColorClass(dollars: number): string {
  if (dollars <= 0) return "text-destructive";
  if (dollars <= 1) return "text-amber-500 dark:text-amber-400";
  return "text-foreground";
}

export function DecoCreditsHero() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();
  const allKeys = useAiProviderKeys();
  const decoKey = allKeys.find((k) => k.providerId === "deco");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const { mutate: disconnect, isPending: isDisconnecting } = useMutation({
    mutationFn: async () => {
      if (!decoKey) return;
      await client.callTool({
        name: "AI_PROVIDER_KEY_DELETE",
        arguments: { keyId: decoKey.id },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(org.id) });
      toast.success("Deco AI Gateway disconnected");
      setConfirmDisconnect(false);
    },
    onError: (err) => {
      toast.error(`Failed to disconnect: ${err.message}`);
    },
  });

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: KEYS.aiProviderCredits(org.id, "deco"),
    enabled: !!decoKey,
    staleTime: 60_000,
    queryFn: async () => {
      const result = (await client.callTool({
        name: "AI_PROVIDER_CREDITS",
        arguments: { providerId: "deco" },
      })) as {
        structuredContent?: { balanceCents: number };
        isError?: boolean;
      };
      if (result?.isError) return null;
      return result.structuredContent ?? null;
    },
  });

  if (!decoKey) return null;

  const balanceDollars =
    data?.balanceCents != null ? data.balanceCents / 100 : null;
  const displayBalance =
    balanceDollars != null ? `$${balanceDollars.toFixed(2)}` : "—";

  return (
    <SettingsSection title="Deco AI Gateway">
      <SettingsCard>
        <div className="px-5 py-5 flex flex-col gap-5">
          {/* Provider info and disconnect button */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img
                src="/logos/deco%20logo.svg"
                alt="Deco AI Gateway"
                className="size-9 rounded-lg object-contain dark:bg-white dark:p-0.5"
              />
              <div>
                <p className="text-xs text-muted-foreground">
                  Access to 100+ models
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmDisconnect(true)}
              disabled={isDisconnecting}
            >
              Disconnect
            </Button>
          </div>

          <AlertDialog
            open={confirmDisconnect}
            onOpenChange={setConfirmDisconnect}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect Deco AI Gateway</AlertDialogTitle>
                <AlertDialogDescription>
                  This will remove the Deco AI Gateway from this workspace. Your
                  credit balance is preserved and will be available if you
                  reconnect.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => disconnect()}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Disconnect
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* Balance */}
          <div className="flex flex-col gap-2 pt-2">
            <div className="flex items-baseline gap-2">
              {isLoading || isFetching ? (
                <Skeleton className="h-9 w-24" />
              ) : (
                <span
                  className={cn(
                    "text-3xl font-semibold tabular-nums tracking-tight",
                    balanceDollars != null && creditColorClass(balanceDollars),
                  )}
                >
                  {displayBalance}
                </span>
              )}
              <button
                type="button"
                onClick={() => refetch()}
                disabled={isFetching}
                className="text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors p-1 rounded-md hover:bg-muted/50"
                aria-label="Refresh balance"
              >
                <RefreshCw01
                  size={14}
                  className={cn(isFetching && "animate-spin")}
                />
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Available credit balance
            </p>
          </div>

          {/* Quick top-up */}
          <div className="pt-4 border-t border-border/60">
            <p className="text-xs font-medium text-muted-foreground mb-2.5">
              Add credits
            </p>
            <QuickTopUp />
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
