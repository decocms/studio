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
import { cn } from "@deco/ui/lib/utils.ts";
import { AlertCircle, Coins01, Plus } from "@untitledui/icons";
import {
  useConnections,
  useMCPClient,
  useMCPToolCallMutation,
  useMCPToolCallQuery,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { isDecoAIGatewayUrl } from "@/core/deco-constants";

// -- Types --

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
  billing: { mode: "prepaid" | "postpaid" };
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
  billing_mode: "prepaid" | "postpaid";
  new_limit_usd: number;
  current_limit_usd: number;
  amount_usd: number | null;
}

interface UsageDataPoint {
  date: string;
  amount: number;
}

// -- Helpers --

function formatUSD(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function buildChartData(
  period: ChartPeriod,
  usage: GatewayUsageResult["usage"],
): UsageDataPoint[] {
  const now = new Date();
  const data: UsageDataPoint[] = [];

  if (period === "day") {
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      data.push({
        date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        amount: i === 0 ? usage.daily : 0,
      });
    }
    data[data.length - 1] = {
      date: data[data.length - 1]?.date ?? "Today",
      amount: usage.daily,
    };
  } else if (period === "week") {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i * 7);
      data.push({
        date: `W${String(52 - i)}`,
        amount: i === 0 ? usage.weekly : 0,
      });
    }
    data[data.length - 1] = {
      date: data[data.length - 1]?.date ?? "This week",
      amount: usage.weekly,
    };
  } else {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now);
      d.setMonth(d.getMonth() - i);
      data.push({
        date: d.toLocaleDateString("en-US", {
          month: "short",
          year: "2-digit",
        }),
        amount: i === 0 ? usage.monthly : 0,
      });
    }
    data[data.length - 1] = {
      date: data[data.length - 1]?.date ?? "This month",
      amount: usage.monthly,
    };
  }

  return data;
}

const CONFIDENCE_LABEL: Record<CreditEstimation["confidence"], string> = {
  low: "Low confidence",
  medium: "Medium confidence",
  high: "High confidence",
};

// -- Add Credit Dialog --

const PRESET_AMOUNTS = [5, 10, 25, 50, 100];

interface AddCreditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  currentLimitUsd: number;
}

function AddCreditDialog({
  open,
  onOpenChange,
  connectionId,
  currentLimitUsd,
}: AddCreditDialogProps) {
  const { org } = useProjectContext();
  const [selectedAmount, setSelectedAmount] = useState<number | null>(null);
  const [customAmount, setCustomAmount] = useState("");
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const client = useMCPClient({ connectionId, orgId: org.id });

  const { mutate, isPending } = useMCPToolCallMutation({ client });

  const effectiveAmount =
    selectedAmount ?? (customAmount ? parseFloat(customAmount) : null);

  const handleConfirm = () => {
    if (!effectiveAmount || effectiveAmount <= 0) return;

    const newLimit = currentLimitUsd + effectiveAmount;
    setError(null);

    mutate(
      {
        name: "GATEWAY_SET_LIMIT",
        arguments: {
          limit_usd: newLimit,
          return_url: window.location.href,
        },
      },
      {
        onSuccess: (result) => {
          const payload = (result as { structuredContent?: SetLimitResult })
            .structuredContent;

          if (payload?.checkout_url) {
            setCheckoutUrl(payload.checkout_url);
          } else if (payload?.billing_mode === "postpaid") {
            handleClose();
          }
        },
        onError: (err) => {
          setError(err.message ?? "Failed to create payment link.");
        },
      },
    );
  };

  const handleClose = () => {
    setSelectedAmount(null);
    setCustomAmount("");
    setCheckoutUrl(null);
    setError(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Credit</DialogTitle>
          <DialogDescription>
            Choose how much credit to add to your AI Gateway.
          </DialogDescription>
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
                Select amount
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
                Or enter a custom amount
              </Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  id="custom-amount"
                  type="number"
                  min="1"
                  step="1"
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

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex items-center justify-between pt-1">
              <p className="text-xs text-muted-foreground">
                Current limit:{" "}
                <span className="font-medium text-foreground">
                  {formatUSD(currentLimitUsd)}
                </span>
              </p>
              <Button
                onClick={handleConfirm}
                disabled={isPending || !effectiveAmount || effectiveAmount <= 0}
                className="gap-2"
              >
                {isPending ? "Generating..." : "Continue"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// -- Credit Forecast --

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

// -- Credit card --

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
}: {
  connectionId: string;
  alert: AlertConfig;
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

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertCircle size={16} className="text-muted-foreground" />
          <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
            Low-Balance Alert
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
              Alert threshold
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
            {enabled
              ? `Notify when credit drops below ${formatUSD(parseFloat(thresholdStr) || 0)}`
              : "Alerts are disabled"}
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

type ChartPeriod = "day" | "week" | "month";

const PERIOD_LABELS: Record<ChartPeriod, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

const PERIOD_USAGE_KEY: Record<ChartPeriod, keyof GatewayUsageResult["usage"]> =
  {
    day: "daily",
    week: "weekly",
    month: "monthly",
  };

const chartConfig = {
  amount: { label: "Spend", color: "var(--chart-1)" },
} satisfies ChartConfig;

function UsageSection({ usage }: { usage: GatewayUsageResult["usage"] }) {
  const [period, setPeriod] = useState<ChartPeriod>("day");
  const data = buildChartData(period, usage);
  const periodTotal = usage[PERIOD_USAGE_KEY[period]];

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
            <p className="text-xs text-muted-foreground">
              {period === "day"
                ? "today"
                : period === "week"
                  ? "this week"
                  : "this month"}
            </p>
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            {formatUSD(usage.total)} all-time
          </p>
        </div>
        <div className="flex items-center rounded-md border border-border bg-muted/50 p-0.5">
          {(Object.keys(PERIOD_LABELS) as ChartPeriod[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={cn(
                "px-2.5 py-1 text-xs font-medium rounded-sm transition-colors",
                period === p
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      <ChartContainer config={chartConfig} className="h-[280px] w-full">
        <AreaChart
          data={data}
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
    </div>
  );
}

// -- Billing with real data --

function BillingWithData({ connectionId }: { connectionId: string }) {
  const { org } = useProjectContext();
  const [addCreditOpen, setAddCreditOpen] = useState(false);

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
  const estimation = data?.estimation ?? null;
  const alert = data?.alert ?? {
    enabled: false,
    threshold_usd: 10,
    email: null,
  };
  const currentLimitUsd = total;

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

      <CreditCard
        available={available}
        total={total}
        estimation={estimation}
        onAddCredit={() => setAddCreditOpen(true)}
      />

      <UsageSection usage={usage} />

      <AlertSection
        key={`${alert.enabled}-${alert.threshold_usd}-${alert.email}`}
        connectionId={connectionId}
        alert={alert}
      />

      <AddCreditDialog
        open={addCreditOpen}
        onOpenChange={setAddCreditOpen}
        connectionId={connectionId}
        currentLimitUsd={currentLimitUsd}
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
