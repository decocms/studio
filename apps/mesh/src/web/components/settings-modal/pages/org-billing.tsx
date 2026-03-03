import { Component, Suspense, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@deco/ui/components/chart.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@deco/ui/components/dialog.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@deco/ui/components/tabs.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { AlertCircle, Coins01, Plus, RefreshCcw01 } from "@untitledui/icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  KEYS,
  SELF_MCP_ALIAS_ID,
  useConnections,
  useMCPClient,
  useMCPToolCallMutation,
  useMCPToolCallQuery,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { isDecoAIGatewayUrl } from "@/core/deco-constants";

// -- Types --

type BillingMode = "prepaid" | "postpaid";
type LimitPeriod = "daily" | "weekly" | "monthly";

interface CreditEstimation {
  avgDailySpend: number;
  estimatedDaysRemaining: number | null;
  estimatedDepletionDate: string | null;
  resetsBeforeDepletion: boolean;
  confidence: "low" | "medium" | "high";
  basedOn: "monthly" | "weekly" | "daily";
}

interface AlertConfig {
  enabled: boolean;
  threshold_usd: number;
  email: string | null;
}

interface GatewayUsageResult {
  billing: { mode: BillingMode; limitPeriod: LimitPeriod | null };
  limit: {
    total: number | null;
    remaining: number | null;
    reset: string | null;
    includeByokInLimit: boolean;
  };
  usage: { total: number; daily: number; weekly: number; monthly: number };
  estimation: CreditEstimation | null;
  alert: AlertConfig;
  connectionId: string;
}

interface SetLimitResult {
  checkout_url: string | null;
  billing_mode: BillingMode;
  limit_period: LimitPeriod | null;
  new_limit_usd: number;
  current_limit_usd: number;
  amount_usd: number | null;
}

interface UsageDataPoint {
  date: string;
  amount: number;
}

type BillingStatsPeriod = "7d" | "30d" | "90d";

interface BillingStatsResult {
  timeseries: Array<{ timestamp: string; cost: number; calls: number }>;
  byConnection: Array<{ title: string; cost: number; calls: number }>;
  byModel: Array<{ model: string; cost: number; calls: number }>;
  byUser: Array<{ userId: string; cost: number; calls: number }>;
  topTools: Array<{ name: string; cost: number; calls: number }>;
  totals: { cost: number; calls: number };
}

interface BillingHistoryPayment {
  id: string;
  amountUsd: number;
  currentLimitUsd: number | null;
  newLimitUsd: number;
  status: "completed" | "expired";
  createdAt: string;
  completedAt: string | null;
}

interface BillingHistoryResult {
  payments: BillingHistoryPayment[];
}

// -- Helpers --

function formatUSD(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const CHIP_PERIOD_KEY = "gateway-chip-period";

function getChipPeriod(): LimitPeriod {
  try {
    const stored = localStorage.getItem(CHIP_PERIOD_KEY);
    if (stored === "daily" || stored === "weekly" || stored === "monthly")
      return stored;
  } catch {
    // ignore
  }
  return "daily";
}

function setChipPeriod(period: LimitPeriod) {
  try {
    localStorage.setItem(CHIP_PERIOD_KEY, period);
  } catch {
    // ignore
  }
}

const CONFIDENCE_LABEL: Record<CreditEstimation["confidence"], string> = {
  low: "Low confidence",
  medium: "Medium confidence",
  high: "High confidence",
};

const PERIOD_LABEL: Record<LimitPeriod, string> = {
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
};

// -- Add Credit / Configure Limit Dialog --

const PRESET_AMOUNTS = [5, 10, 25, 50, 100];
const LIMIT_PERIODS: Array<{ value: LimitPeriod | "none"; label: string }> = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "none", label: "No reset" },
];

interface LimitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  currentLimitUsd: number;
  billingMode: BillingMode;
  currentLimitPeriod: LimitPeriod | null;
}

function LimitDialog({
  open,
  onOpenChange,
  connectionId,
  currentLimitUsd,
  billingMode,
  currentLimitPeriod,
}: LimitDialogProps) {
  const { org } = useProjectContext();
  const [selectedAmount, setSelectedAmount] = useState<number | null>(null);
  const [customAmount, setCustomAmount] = useState("");
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limitPeriod, setLimitPeriod] = useState<LimitPeriod | "none">(
    currentLimitPeriod ?? "none",
  );

  const client = useMCPClient({ connectionId, orgId: org.id });
  const { mutate, isPending } = useMCPToolCallMutation({ client });
  const queryClient = useQueryClient();

  const isPostpaid = billingMode === "postpaid";
  const customAmountValue = customAmount
    ? Number.parseFloat(customAmount)
    : null;
  const effectiveAmount = selectedAmount ?? customAmountValue;
  const resolvedLimitPeriod = limitPeriod === "none" ? null : limitPeriod;
  const isUnchangedPostpaid =
    isPostpaid &&
    effectiveAmount != null &&
    effectiveAmount === currentLimitUsd &&
    resolvedLimitPeriod === currentLimitPeriod;
  const gatewayUsageQueryKey = KEYS.mcpToolCall(
    client,
    "GATEWAY_USAGE",
    JSON.stringify({}),
  );

  const refreshGatewayUsage = async () => {
    await queryClient.invalidateQueries({
      queryKey: gatewayUsageQueryKey,
      exact: true,
    });
    await queryClient.refetchQueries({
      queryKey: gatewayUsageQueryKey,
      exact: true,
      type: "active",
    });
  };

  const handleConfirm = () => {
    if (!effectiveAmount || effectiveAmount <= 0) return;

    const newLimit = isPostpaid
      ? effectiveAmount
      : currentLimitUsd + effectiveAmount;
    setError(null);

    const args: Record<string, unknown> = {
      limit_usd: newLimit,
      billing_mode: billingMode,
      return_url: window.location.href,
    };
    if (isPostpaid) {
      args.limit_period = limitPeriod;
    }

    mutate(
      { name: "GATEWAY_SET_LIMIT", arguments: args },
      {
        onSuccess: async (result) => {
          const payload = (result as { structuredContent?: SetLimitResult })
            .structuredContent;

          if (!payload?.checkout_url) {
            await refreshGatewayUsage();
          }

          if (payload?.checkout_url) {
            setCheckoutUrl(payload.checkout_url);
          } else {
            handleClose();
          }
        },
        onError: (err) => {
          setError(err.message ?? "Failed to update limit.");
        },
      },
    );
  };

  const handleClose = () => {
    setSelectedAmount(null);
    setCustomAmount("");
    setCheckoutUrl(null);
    setError(null);
    setLimitPeriod(currentLimitPeriod ?? "none");
    onOpenChange(false);
  };

  const title = isPostpaid ? "Configure Spending Limit" : "Add Credit";
  const description = isPostpaid
    ? "Set a spending limit for your AI Gateway. The limit resets automatically based on the selected period."
    : "Choose how much credit to add to your AI Gateway.";
  const amountLabel = isPostpaid ? "New limit" : "Select amount";
  const confirmLabel = isPostpaid ? "Set Limit" : "Continue";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {checkoutUrl ? (
          <div className="flex flex-col gap-4 pt-2">
            <p className="text-sm text-muted-foreground">
              Your payment link is ready. Click below to complete the purchase.
              You'll be redirected back here after payment.
            </p>
            <Button asChild className="gap-2">
              <a href={checkoutUrl}>
                <Coins01 size={15} />
                Complete Payment
              </a>
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-5 pt-2">
            {/* Preset amounts */}
            <div className="flex flex-col gap-2">
              <Label className="text-xs text-muted-foreground">
                {amountLabel}
              </Label>
              <div className="grid grid-cols-5 gap-2">
                {PRESET_AMOUNTS.map((amount) => (
                  <button
                    key={amount}
                    type="button"
                    onClick={() => {
                      setSelectedAmount(amount);
                      setCustomAmount("");
                    }}
                    className={cn(
                      "rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                      selectedAmount === amount
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border hover:bg-muted",
                    )}
                  >
                    ${amount}
                  </button>
                ))}
              </div>
            </div>

            {/* Custom amount */}
            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor="custom-amount"
                className="text-xs text-muted-foreground"
              >
                {isPostpaid
                  ? "Or enter the exact new limit"
                  : "Or enter a custom amount"}
              </Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  id="custom-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  className="pl-7"
                  value={customAmount}
                  onChange={(e) => {
                    setCustomAmount(e.target.value);
                    setSelectedAmount(null);
                  }}
                />
              </div>
            </div>

            {/* Period selector — postpaid only */}
            {isPostpaid && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">
                  Reset period
                </Label>
                <div className="grid grid-cols-4 gap-2">
                  {LIMIT_PERIODS.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setLimitPeriod(value)}
                      className={cn(
                        "rounded-md border px-2 py-2 text-xs font-medium transition-colors",
                        limitPeriod === value
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border hover:bg-muted",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex items-center justify-between pt-1">
              <p className="text-xs text-muted-foreground">
                {isPostpaid ? (
                  <>
                    Current limit:{" "}
                    <span className="font-medium text-foreground">
                      {currentLimitUsd > 0
                        ? formatUSD(currentLimitUsd)
                        : "none"}
                    </span>
                  </>
                ) : (
                  <>
                    Current limit:{" "}
                    <span className="font-medium text-foreground">
                      {formatUSD(currentLimitUsd)}
                    </span>
                  </>
                )}
              </p>
              <Button
                onClick={handleConfirm}
                disabled={
                  isPending ||
                  !effectiveAmount ||
                  effectiveAmount <= 0 ||
                  isUnchangedPostpaid
                }
                className="gap-2"
              >
                {isPending ? "Updating..." : confirmLabel}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// -- Credit Forecast (prepaid only) --

function CreditForecast({
  estimation,
}: {
  estimation: CreditEstimation | null;
}) {
  if (!estimation) return null;

  const { estimatedDaysRemaining, estimatedDepletionDate, avgDailySpend } =
    estimation;

  if (estimatedDaysRemaining == null) return null;

  const depletionLabel = estimatedDepletionDate
    ? new Date(estimatedDepletionDate).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <div className="mt-3 flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
      <span className="tabular-nums font-medium text-foreground">
        ~{estimatedDaysRemaining} day{estimatedDaysRemaining !== 1 ? "s" : ""}{" "}
        remaining
      </span>
      {depletionLabel && <span>(until {depletionLabel})</span>}
      <span className="text-muted-foreground/60">|</span>
      <span className="tabular-nums">avg {formatUSD(avgDailySpend)}/day</span>
      {estimation.resetsBeforeDepletion && (
        <>
          <span className="text-muted-foreground/60">|</span>
          <span className="text-green-600 dark:text-green-400">
            Resets before depletion
          </span>
        </>
      )}
      <Badge
        variant="outline"
        className="text-[10px] px-1.5 py-0 h-4 font-normal"
      >
        {CONFIDENCE_LABEL[estimation.confidence]}
      </Badge>
    </div>
  );
}

// -- Spending Card (postpaid) --

function SpendingCard({
  usage,
  limit,
  limitPeriod,
  onConfigureLimit,
}: {
  usage: GatewayUsageResult["usage"];
  limit: GatewayUsageResult["limit"];
  limitPeriod: LimitPeriod | null;
  onConfigureLimit: () => void;
}) {
  const hasLimit = limit.total != null && limit.total > 0;
  const percentUsed = hasLimit
    ? Math.min(
        100,
        Math.round(
          ((limit.total! - (limit.remaining ?? 0)) / limit.total!) * 100,
        ),
      )
    : null;

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-gradient-to-br from-card via-card to-muted/30 p-6">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
            Spending
          </p>
          <p className="text-3xl font-bold tabular-nums text-foreground tracking-tight">
            {formatUSD(usage.total)}
          </p>
          {hasLimit && (
            <p className="text-xs text-muted-foreground">
              of {formatUSD(limit.total!)} limit
              {limitPeriod && (
                <span className="ml-1.5 inline-flex items-center gap-1">
                  <RefreshCcw01 size={10} />
                  {PERIOD_LABEL[limitPeriod]}
                </span>
              )}
            </p>
          )}
          {!hasLimit && (
            <p className="text-xs text-muted-foreground">No limit configured</p>
          )}
        </div>
        <Button onClick={onConfigureLimit} variant="outline" className="gap-2">
          <Plus size={16} />
          {hasLimit ? "Configure Limit" : "Set Limit"}
        </Button>
      </div>

      {hasLimit && percentUsed != null && (
        <div className="mt-4">
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                percentUsed >= 90
                  ? "bg-destructive"
                  : percentUsed >= 70
                    ? "bg-amber-500"
                    : "bg-primary",
              )}
              style={{ width: `${percentUsed}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {percentUsed}% used
            {limit.reset && (
              <span className="ml-2">· resets {limit.reset}</span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

// -- Credit card (prepaid) --

function CreditCard({
  available,
  total,
  estimation,
  onAddCredit,
}: {
  available: number;
  total: number;
  estimation: CreditEstimation | null;
  onAddCredit: () => void;
}) {
  const usedPct =
    total > 0
      ? Math.max(0, Math.min(100, ((total - available) / total) * 100))
      : 0;

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-gradient-to-br from-card via-card to-muted/30 p-6">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
            Available Credit
          </p>
          <p className="text-3xl font-bold tabular-nums text-foreground tracking-tight">
            {formatUSD(available)}
          </p>
          {total > 0 && (
            <p className="text-xs text-muted-foreground">
              of {formatUSD(total)} total
            </p>
          )}
        </div>
        <Button onClick={onAddCredit} className="gap-2 px-5">
          <Plus size={16} />
          Add Credit
        </Button>
      </div>

      {total > 0 && (
        <div className="mt-4">
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${usedPct}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {formatUSD(Math.max(0, total - available))} used
          </p>
        </div>
      )}

      <CreditForecast estimation={estimation} />
    </div>
  );
}

// -- Alert Section --

function AlertSection({
  connectionId,
  alert,
  billingMode,
}: {
  connectionId: string;
  alert: AlertConfig;
  billingMode: BillingMode;
}) {
  const { org } = useProjectContext();
  const [enabled, setEnabled] = useState(alert.enabled);
  const [thresholdStr, setThresholdStr] = useState(String(alert.threshold_usd));
  const [email, setEmail] = useState(alert.email ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const client = useMCPClient({ connectionId, orgId: org.id });
  const { mutate, isPending } = useMCPToolCallMutation({ client });

  const hasChanges =
    enabled !== alert.enabled ||
    thresholdStr !== String(alert.threshold_usd) ||
    email !== (alert.email ?? "");

  const handleSave = () => {
    setError(null);
    setSaved(false);

    const threshold = parseFloat(thresholdStr);
    if (enabled && (!email || !email.includes("@"))) {
      setError("A valid email is required to enable alerts.");
      return;
    }
    if (Number.isNaN(threshold) || threshold <= 0) {
      setError("Threshold must be a positive number.");
      return;
    }

    mutate(
      {
        name: "GATEWAY_SET_ALERT",
        arguments: {
          enabled,
          threshold_usd: threshold,
          ...(email ? { email } : {}),
        },
      },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 3000);
        },
        onError: (err) => {
          setError(err.message ?? "Failed to save alert config.");
        },
      },
    );
  };

  const thresholdDescription =
    billingMode === "postpaid"
      ? `Notify when usage reaches ${formatUSD(parseFloat(thresholdStr) || 0)}`
      : `Notify when credit drops below ${formatUSD(parseFloat(thresholdStr) || 0)}`;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertCircle size={16} className="text-muted-foreground" />
          <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
            {billingMode === "postpaid" ? "Usage Alert" : "Low-Balance Alert"}
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      <div
        className={cn(
          "flex flex-col gap-3 transition-opacity",
          !enabled && "opacity-50 pointer-events-none",
        )}
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor="alert-threshold"
              className="text-xs text-muted-foreground"
            >
              {billingMode === "postpaid"
                ? "Alert at usage"
                : "Alert threshold"}
            </Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                $
              </span>
              <Input
                id="alert-threshold"
                type="number"
                min="1"
                step="1"
                className="pl-7"
                value={thresholdStr}
                onChange={(e) => setThresholdStr(e.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor="alert-email"
              className="text-xs text-muted-foreground"
            >
              Email
            </Label>
            <Input
              id="alert-email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {enabled ? thresholdDescription : "Alerts are disabled"}
          </p>
          <div className="flex items-center gap-2">
            {saved && (
              <span className="text-xs text-green-600 dark:text-green-400">
                Saved
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={handleSave}
              disabled={isPending || !hasChanges}
            >
              {isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// -- Chart section --

const chartConfig = {
  amount: { label: "Spend", color: "var(--chart-1)" },
} satisfies ChartConfig;

function UsageSection({ usage }: { usage: GatewayUsageResult["usage"] }) {
  const { org } = useProjectContext();
  const [period, setPeriod] = useState<BillingStatsPeriod>("30d");

  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data: stats } = useMCPToolCallQuery<BillingStatsResult | undefined>({
    client: selfClient,
    toolName: "MONITORING_BILLING_STATS",
    toolArguments: { period },
    staleTime: 60_000,
    select: (result) =>
      (result as { structuredContent?: BillingStatsResult }).structuredContent,
  });

  const chartData: UsageDataPoint[] = (stats?.timeseries ?? []).map((p) => ({
    date: new Date(p.timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
    amount: p.cost,
  }));

  const periodTotal = stats?.totals.cost ?? 0;
  const periodCalls = stats?.totals.calls ?? 0;

  const periodLabel =
    period === "7d"
      ? "last 7 days"
      : period === "30d"
        ? "last 30 days"
        : "last 90 days";

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
            Usage
          </p>
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-bold tabular-nums text-foreground tracking-tight">
              {formatUSD(periodTotal)}
            </p>
            <p className="text-xs text-muted-foreground">{periodLabel}</p>
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            {periodCalls.toLocaleString()} calls · {formatUSD(usage.total)}{" "}
            all-time
          </p>
        </div>
        <PeriodSelector period={period} onPeriodChange={setPeriod} />
      </div>

      {chartData.length > 0 ? (
        <ChartContainer config={chartConfig} className="h-[200px] w-full">
          <AreaChart
            data={chartData}
            margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
          >
            <defs>
              <linearGradient id="fillAmount" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--color-amount)"
                  stopOpacity={0.3}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-amount)"
                  stopOpacity={0}
                />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              fontSize={11}
              interval="preserveStartEnd"
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={4}
              fontSize={11}
              tickFormatter={(v: number) => `$${v}`}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => formatUSD(value as number)}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="amount"
              stroke="var(--color-amount)"
              fill="url(#fillAmount)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      ) : (
        <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground">
          No usage data available for this period
        </div>
      )}
    </div>
  );
}

// -- Chip display period picker (postpaid, no limit) --

function ChipDisplayPicker() {
  const [period, setPeriod] = useState<LimitPeriod>(getChipPeriod);

  const handleChange = (p: LimitPeriod) => {
    setPeriod(p);
    setChipPeriod(p);
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5">
      <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
        Sidebar Display Period
      </p>
      <p className="text-xs text-muted-foreground">
        Choose which usage period is shown in the sidebar when no limit is set.
      </p>
      <div className="flex gap-2 mt-1">
        {(["daily", "weekly", "monthly"] as LimitPeriod[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => handleChange(p)}
            className={cn(
              "rounded-md border px-3 py-1.5 text-xs font-medium capitalize transition-colors",
              period === p
                ? "border-primary bg-primary/10 text-primary"
                : "border-border hover:bg-muted text-muted-foreground",
            )}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

// -- Horizontal bar row (reused in breakdown sections) --

function HorizontalBarRow({
  label,
  value,
  subValue,
  maxValue,
  color = "bg-chart-1",
}: {
  label: string;
  value: string;
  subValue?: string;
  maxValue: number;
  color?: string;
}) {
  const numericValue = parseFloat(value.replace(/[^0-9.]/g, "")) || 0;
  const pct = maxValue > 0 ? Math.min((numericValue / maxValue) * 100, 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-foreground truncate min-w-0 w-36 shrink-0">
        {label}
      </span>
      <div className="relative h-2 bg-muted/50 overflow-hidden flex-1 rounded-sm">
        <div
          className={cn("h-full transition-all duration-500 ease-out", color)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs tabular-nums shrink-0 text-foreground font-medium">
        {value}
      </span>
      {subValue && (
        <span className="text-xs tabular-nums shrink-0 text-muted-foreground">
          {subValue}
        </span>
      )}
    </div>
  );
}

// -- Breakdown section block --

function BreakdownBlock({
  title,
  children,
  empty,
}: {
  title: string;
  children: ReactNode;
  empty?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
      <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
        {title}
      </p>
      {empty ? (
        <p className="text-xs text-muted-foreground py-4 text-center">
          No data available for this period
        </p>
      ) : (
        children
      )}
    </div>
  );
}

// -- Period selector for breakdown / history tabs --

const STATS_PERIOD_LABELS: Record<BillingStatsPeriod, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
};

function PeriodSelector({
  period,
  onPeriodChange,
}: {
  period: BillingStatsPeriod;
  onPeriodChange: (p: BillingStatsPeriod) => void;
}) {
  return (
    <div className="flex items-center rounded-md border border-border bg-muted/50 p-0.5 self-start">
      {(Object.keys(STATS_PERIOD_LABELS) as BillingStatsPeriod[]).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onPeriodChange(p)}
          className={cn(
            "px-2.5 py-1 text-xs font-medium rounded-sm transition-colors",
            period === p
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {STATS_PERIOD_LABELS[p]}
        </button>
      ))}
    </div>
  );
}

// -- Billing Breakdown Tab (uses MONITORING_BILLING_STATS from self MCP) --

function BillingBreakdown() {
  const { org } = useProjectContext();
  const [period, setPeriod] = useState<BillingStatsPeriod>("30d");

  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data: stats, isLoading } = useMCPToolCallQuery<
    BillingStatsResult | undefined
  >({
    client: selfClient,
    toolName: "MONITORING_BILLING_STATS",
    toolArguments: { period },
    staleTime: 60_000,
    select: (result) =>
      (result as { structuredContent?: BillingStatsResult }).structuredContent,
  });

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  const totals = stats?.totals ?? { cost: 0, calls: 0 };
  const byConnection = stats?.byConnection ?? [];
  const byModel = stats?.byModel ?? [];
  const byUser = stats?.byUser ?? [];
  const topTools = stats?.topTools ?? [];

  const maxConnCost = byConnection[0]?.cost ?? 1;
  const maxModelCost = byModel[0]?.cost ?? 1;
  const maxUserCost = byUser[0]?.cost ?? 1;
  const maxToolCalls = topTools[0]?.calls ?? 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-4 text-sm">
          <span className="text-muted-foreground">
            Total:{" "}
            <span className="font-semibold text-foreground">
              {formatUSD(totals.cost)}
            </span>
          </span>
          <span className="text-muted-foreground">
            Calls:{" "}
            <span className="font-semibold text-foreground">
              {totals.calls.toLocaleString()}
            </span>
          </span>
        </div>
        <PeriodSelector period={period} onPeriodChange={setPeriod} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <BreakdownBlock
          title="Cost by Connection"
          empty={byConnection.length === 0}
        >
          <div className="space-y-2.5">
            {byConnection.slice(0, 8).map((item) => (
              <HorizontalBarRow
                key={item.title}
                label={item.title}
                value={formatUSD(item.cost)}
                subValue={`${item.calls.toLocaleString()} calls`}
                maxValue={maxConnCost}
                color="bg-chart-1"
              />
            ))}
          </div>
        </BreakdownBlock>

        <BreakdownBlock title="Cost by Model" empty={byModel.length === 0}>
          <div className="space-y-2.5">
            {byModel.slice(0, 8).map((item) => (
              <HorizontalBarRow
                key={item.model}
                label={item.model}
                value={formatUSD(item.cost)}
                subValue={`${item.calls.toLocaleString()} calls`}
                maxValue={maxModelCost}
                color="bg-chart-2"
              />
            ))}
          </div>
        </BreakdownBlock>

        <BreakdownBlock title="Cost by User" empty={byUser.length === 0}>
          <div className="space-y-2.5">
            {byUser.slice(0, 8).map((item) => (
              <HorizontalBarRow
                key={item.userId}
                label={item.userId}
                value={formatUSD(item.cost)}
                subValue={`${item.calls.toLocaleString()} calls`}
                maxValue={maxUserCost}
                color="bg-chart-4"
              />
            ))}
          </div>
        </BreakdownBlock>

        <BreakdownBlock title="Top Tools" empty={topTools.length === 0}>
          <div className="space-y-2.5">
            {topTools.slice(0, 8).map((item) => (
              <HorizontalBarRow
                key={item.name}
                label={item.name}
                value={item.calls.toLocaleString()}
                subValue={item.cost > 0 ? formatUSD(item.cost) : undefined}
                maxValue={maxToolCalls}
                color="bg-chart-3"
              />
            ))}
          </div>
        </BreakdownBlock>
      </div>
    </div>
  );
}

// -- Monthly bucket helper for history --

function bucketTimeseriesByMonth(
  timeseries: Array<{ timestamp: string; cost: number; calls: number }>,
): Array<{ month: string; cost: number; calls: number }> {
  const buckets = new Map<string, { cost: number; calls: number }>();
  for (const point of timeseries) {
    const d = new Date(point.timestamp);
    const key = d.toLocaleDateString("en-US", {
      month: "short",
      year: "2-digit",
    });
    const existing = buckets.get(key) ?? { cost: 0, calls: 0 };
    buckets.set(key, {
      cost: existing.cost + point.cost,
      calls: existing.calls + point.calls,
    });
  }
  return Array.from(buckets.entries())
    .map(([month, data]) => ({ month, ...data }))
    .reverse();
}

// -- Billing History Tab --

function BillingHistory({
  connectionId,
  billingMode,
}: {
  connectionId: string;
  billingMode: BillingMode;
}) {
  const { org } = useProjectContext();
  const [period, setPeriod] = useState<BillingStatsPeriod>("90d");

  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const gatewayClient = useMCPClient({ connectionId, orgId: org.id });

  const { data: stats, isLoading: statsLoading } = useMCPToolCallQuery<
    BillingStatsResult | undefined
  >({
    client: selfClient,
    toolName: "MONITORING_BILLING_STATS",
    toolArguments: { period },
    staleTime: 60_000,
    select: (result) =>
      (result as { structuredContent?: BillingStatsResult }).structuredContent,
  });

  const { data: history, isLoading: historyLoading } = useMCPToolCallQuery<
    BillingHistoryResult | undefined
  >({
    client: gatewayClient,
    toolName: "GATEWAY_BILLING_HISTORY",
    toolArguments: {},
    staleTime: 60_000,
    select: (result) =>
      (result as { structuredContent?: BillingHistoryResult })
        .structuredContent,
    enabled: billingMode === "prepaid",
  });

  const isLoading =
    statsLoading || (billingMode === "prepaid" && historyLoading);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  const monthlyBuckets = bucketTimeseriesByMonth(stats?.timeseries ?? []);
  const payments = history?.payments ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Usage history from monitoring logs
        </p>
        <PeriodSelector period={period} onPeriodChange={setPeriod} />
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
        <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
          Monthly Usage
        </p>
        {monthlyBuckets.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            No usage data available for this period
          </p>
        ) : (
          <div className="w-full">
            <div className="grid grid-cols-3 gap-x-4 pb-1.5 border-b border-border text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              <span>Month</span>
              <span className="text-right">Cost</span>
              <span className="text-right">Calls</span>
            </div>
            <div className="divide-y divide-border">
              {monthlyBuckets.map((bucket) => (
                <div
                  key={bucket.month}
                  className="grid grid-cols-3 gap-x-4 py-2 text-xs"
                >
                  <span className="text-foreground font-medium">
                    {bucket.month}
                  </span>
                  <span className="text-right tabular-nums text-foreground">
                    {formatUSD(bucket.cost)}
                  </span>
                  <span className="text-right tabular-nums text-muted-foreground">
                    {bucket.calls.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {billingMode === "prepaid" && (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
          <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
            Credit Purchases
          </p>
          {payments.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              No payment history found
            </p>
          ) : (
            <div className="w-full">
              <div className="grid grid-cols-4 gap-x-4 pb-1.5 border-b border-border text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                <span>Date</span>
                <span className="text-right">Amount</span>
                <span className="text-right">New Limit</span>
                <span className="text-right">Status</span>
              </div>
              <div className="divide-y divide-border">
                {payments.map((p) => (
                  <div
                    key={p.id}
                    className="grid grid-cols-4 gap-x-4 py-2 text-xs"
                  >
                    <span className="text-muted-foreground">
                      {new Date(p.createdAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "2-digit",
                      })}
                    </span>
                    <span className="text-right tabular-nums text-foreground font-medium">
                      {formatUSD(p.amountUsd)}
                    </span>
                    <span className="text-right tabular-nums text-foreground">
                      {formatUSD(p.newLimitUsd)}
                    </span>
                    <span
                      className={cn(
                        "text-right capitalize",
                        p.status === "completed"
                          ? "text-green-600 dark:text-green-400"
                          : "text-muted-foreground",
                      )}
                    >
                      {p.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// -- Billing with real data --

function BillingWithData({ connectionId }: { connectionId: string }) {
  const { org } = useProjectContext();
  const [limitDialogOpen, setLimitDialogOpen] = useState(false);

  const client = useMCPClient({ connectionId, orgId: org.id });

  const { data, isLoading } = useMCPToolCallQuery<
    GatewayUsageResult | undefined
  >({
    client,
    toolName: "GATEWAY_USAGE",
    toolArguments: {},
    staleTime: 30_000,
    select: (result) =>
      (result as { structuredContent?: GatewayUsageResult }).structuredContent,
  });

  if (isLoading) return <BillingSkeleton />;

  const available = data?.limit.remaining ?? 0;
  const total = data?.limit.total ?? 0;
  const usage = data?.usage ?? { total: 0, daily: 0, weekly: 0, monthly: 0 };
  const billingMode = data?.billing.mode ?? "prepaid";
  const limitPeriod = data?.billing.limitPeriod ?? null;
  const estimation = data?.estimation ?? null;
  const alert = data?.alert ?? {
    enabled: false,
    threshold_usd: 10,
    email: null,
  };
  const limit = data?.limit ?? {
    total: null,
    remaining: null,
    reset: null,
    includeByokInLimit: false,
  };

  const showChipPicker =
    billingMode === "postpaid" && (total == null || total === 0);

  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold text-foreground">Billing</h2>
        {billingMode === "postpaid" && (
          <Badge
            variant="outline"
            className="text-[10px] px-1.5 py-0 h-4 font-normal capitalize"
          >
            Postpaid
          </Badge>
        )}
      </div>

      <Tabs defaultValue="summary" variant="underline">
        <TabsList variant="underline">
          <TabsTrigger value="summary" variant="underline">
            Summary
          </TabsTrigger>
          <TabsTrigger value="breakdown" variant="underline">
            Breakdown
          </TabsTrigger>
          <TabsTrigger value="history" variant="underline">
            History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="summary" className="flex flex-col gap-4 pt-2">
          {billingMode === "postpaid" ? (
            <SpendingCard
              usage={usage}
              limit={limit}
              limitPeriod={limitPeriod}
              onConfigureLimit={() => setLimitDialogOpen(true)}
            />
          ) : (
            <CreditCard
              available={available}
              total={total}
              estimation={estimation}
              onAddCredit={() => setLimitDialogOpen(true)}
            />
          )}

          <UsageSection usage={usage} />

          {showChipPicker && <ChipDisplayPicker />}

          <AlertSection
            key={`${alert.enabled}-${alert.threshold_usd}-${alert.email}`}
            connectionId={connectionId}
            alert={alert}
            billingMode={billingMode}
          />
        </TabsContent>

        <TabsContent value="breakdown" className="pt-2">
          <BillingBreakdown />
        </TabsContent>

        <TabsContent value="history" className="pt-2">
          <BillingHistory
            connectionId={connectionId}
            billingMode={billingMode}
          />
        </TabsContent>
      </Tabs>

      <LimitDialog
        open={limitDialogOpen}
        onOpenChange={setLimitDialogOpen}
        connectionId={connectionId}
        currentLimitUsd={total}
        billingMode={billingMode}
        currentLimitPeriod={limitPeriod}
      />
    </>
  );
}

// -- Loading / Error / Empty states --

function BillingSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-64 mt-1.5" />
      </div>
      <Skeleton className="h-28 rounded-xl" />
      <Skeleton className="h-[260px] rounded-lg" />
    </div>
  );
}

function BillingEmpty() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">Billing</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Monitor usage and manage credits for your organization.
        </p>
      </div>

      <div className="flex flex-col items-center justify-center gap-3 py-12 rounded-lg border border-dashed border-border">
        <div className="flex items-center justify-center size-10 rounded-full bg-muted">
          <Coins01 size={20} className="text-muted-foreground" />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">
            No AI Gateway configured
          </p>
          <p className="text-xs text-muted-foreground mt-1 max-w-[300px]">
            Install the Deco AI Gateway MCP to start tracking usage and managing
            credits.
          </p>
        </div>
      </div>
    </div>
  );
}

// -- Error boundary --

class BillingErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {}

  override render(): ReactNode {
    if (this.state.hasError) return <BillingEmpty />;
    return this.props.children;
  }
}

// -- Inner component that reads connections (suspends) --

function BillingContent() {
  const connections = useConnections();

  const gatewayConnection = connections.find((c) =>
    isDecoAIGatewayUrl(c.connection_url),
  );

  if (!gatewayConnection?.id) {
    return <BillingEmpty />;
  }

  return (
    <>
      <BillingWithData connectionId={gatewayConnection.id} />
    </>
  );
}

// -- Main Page --

export function OrgBillingPage() {
  return (
    <div className="flex flex-col gap-6">
      <BillingErrorBoundary>
        <Suspense fallback={<BillingSkeleton />}>
          <BillingContent />
        </Suspense>
      </BillingErrorBoundary>
    </div>
  );
}
