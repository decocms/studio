/**
 * Settings > Infra Billing — a port of the deco.cx admin's billing dashboard
 * for orgs that still own legacy sites (`org_sites`). Read-only: usage,
 * plan and issued invoices. Scoped to one site at a time, since Studio's
 * ownership unit is the site slug, not the legacy team.
 */

import { useState } from "react";
import { CreditCard01, LinkExternal01 } from "@untitledui/icons";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { MultiSelect } from "@decocms/ui/components/multi-select.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { Page } from "@/components/page";
import {
  SettingsPage,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t.ts";
import {
  useInfraBilling,
  useInfraBillingPortal,
  useOwnedSites,
} from "@/hooks/use-infra-billing";

type UsageRow = {
  date: string;
  requests: number;
  dataTransferBytes: number;
  pageviews: number;
};

type MetricKey = keyof Omit<UsageRow, "date">;

const NUMBER_FMT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const exponent = Math.min(
    BYTE_UNITS.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${BYTE_UNITS[exponent]}`;
}

/** Mirrors the `siteSlugs` cap on INFRA_BILLING_GET. */
const MAX_SELECTED_SITES = 50;

/** Bank-transfer instructions, for teams billed by transfer rather than boleto. */
const BANK_TRANSFER_PDF_URL =
  "https://assets.decocache.com/decocms/45f9e905-046b-4aeb-8420-0377a7d0d041/deco_Transferencia.pdf";

/** Legacy invoices are issued in BRL. */
const CURRENCY_FMT = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

/**
 * PostgREST emits offset-less timestamps, which JS parses as *local* time — far
 * enough east and an August invoice renders as July. Pin the calendar day.
 */
function utcDay(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`);
}

/** The last 12 months, newest first, as "YYYY-MM-01" values. */
function monthOptions(): { value: string; label: string }[] {
  const now = new Date();
  return Array.from({ length: 12 }, (_, i) => {
    const date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
    );
    return {
      value: date.toISOString().slice(0, 10),
      label: date.toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }),
    };
  });
}

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function UsageChart({
  usage,
  metric,
  colorNum,
  formatValue,
  height,
}: {
  usage: UsageRow[];
  metric: MetricKey;
  colorNum: number;
  formatValue: (value: number) => string;
  height: number;
}) {
  const color = `var(--chart-${colorNum})`;
  const gradientId = `infra-billing-${metric}`;
  const data = usage.map((row) => ({ ...row, label: dayLabel(row.date) }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ left: 0, right: 4, top: 8, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {height > 100 && (
          <>
            <CartesianGrid
              strokeDasharray="4 4"
              stroke="var(--border)"
              strokeOpacity={0.5}
              vertical={false}
            />
            <XAxis
              dataKey="label"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              interval="preserveStartEnd"
              tickMargin={8}
            />
            <YAxis
              orientation="right"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickFormatter={formatValue}
              width={68}
            />
          </>
        )}
        <Tooltip
          cursor={{ stroke: "var(--border)", strokeDasharray: "4 4" }}
          contentStyle={{
            background: "var(--background)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
          }}
          formatter={(value) => formatValue(Number(value) || 0)}
        />
        <Area
          type="linear"
          dataKey={metric}
          stroke={color}
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function sum(usage: UsageRow[], metric: MetricKey): number {
  return usage.reduce((total, row) => total + row[metric], 0);
}

function InfraBillingContent() {
  const t = useT();
  const { sites, isLoading: sitesLoading } = useOwnedSites();
  /** null = not narrowed, which reads as every site the org owns. */
  const [narrowedTo, setNarrowedTo] = useState<string[] | null>(null);
  const months = monthOptions();
  const [period, setPeriod] = useState(months[0]!.value);

  // Unnarrowed, a 51-site org would fail INFRA_BILLING_GET's schema every load.
  const selected = narrowedTo ?? sites.slice(0, MAX_SELECTED_SITES);
  const truncated = !narrowedTo && sites.length > MAX_SELECTED_SITES;
  const { data, isLoading } = useInfraBilling(selected, period);
  const portal = useInfraBillingPortal();

  if (sitesLoading) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (sites.length === 0) {
    return (
      <Card className="p-6 text-sm text-muted-foreground">
        {t("settings.infraBilling.noSites")}
      </Card>
    );
  }

  const usage = data?.usage ?? [];
  const pageviewsAvailable = data?.pageviewsAvailable ?? false;
  /** Zeros from an unread warehouse are absence of data, not absence of traffic. */
  const usageReadable = !!data && !data.usageUnavailable;
  const usageTotal = (metric: MetricKey, format: (n: number) => string) =>
    usageReadable ? format(sum(usage, metric)) : "—";

  const metrics: {
    key: MetricKey;
    title: string;
    description: string;
    colorNum: number;
    total: string;
  }[] = [
    {
      key: "pageviews",
      title: t("settings.infraBilling.pageviews"),
      description: t("settings.infraBilling.pageviewsDescription"),
      colorNum: 1,
      total:
        pageviewsAvailable && usageReadable
          ? NUMBER_FMT.format(sum(usage, "pageviews"))
          : "—",
    },
    {
      key: "requests",
      title: t("settings.infraBilling.requests"),
      description: t("settings.infraBilling.requestsDescription"),
      colorNum: 2,
      total: usageTotal("requests", (n) => NUMBER_FMT.format(n)),
    },
    {
      key: "dataTransferBytes",
      title: t("settings.infraBilling.dataTransfer"),
      description: t("settings.infraBilling.dataTransferDescription"),
      colorNum: 3,
      total: usageTotal("dataTransferBytes", formatBytes),
    },
  ];

  const formatFor = (key: MetricKey) =>
    key === "dataTransferBytes"
      ? formatBytes
      : (value: number) => NUMBER_FMT.format(value);

  const billing = data?.billing ?? null;
  /** One boleto in the team's history means boleto is how they pay. */
  const teamUsesBankSlip = (billing?.invoices ?? []).some(
    (i) => !!i.bankSlipUrl,
  );

  const totalPageviews = sum(usage, "pageviews");
  const ratio =
    totalPageviews > 0 ? sum(usage, "requests") / totalPageviews : 0;
  const requestRatio =
    pageviewsAvailable && usageReadable && totalPageviews > 0
      ? ratio.toFixed(ratio < 10 ? 1 : 0)
      : "—";

  /** Null billing has four causes; only one of them is the user's to fix. */
  const billingMessage = {
    multiple_teams: t("settings.infraBilling.multipleTeams"),
    no_team: t("settings.infraBilling.noTeam"),
    partial_team: t("settings.infraBilling.partialTeam"),
    unavailable: t("settings.infraBilling.billingUnavailable"),
  }[data?.billingUnavailableReason ?? "multiple_teams"];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3 px-4">
        <MultiSelect
          className="w-auto min-w-56 max-w-full"
          options={sites.map((slug) => ({ label: slug, value: slug }))}
          defaultValue={selected}
          maxCount={2}
          placeholder={t("settings.infraBilling.siteLabel")}
          onValueChange={setNarrowedTo}
        />
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger
            className="w-48"
            aria-label={t("settings.infraBilling.monthLabel")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {months.map((month) => (
              <SelectItem key={month.value} value={month.value}>
                {month.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selected.length === 0 && (
        <Card className="mx-4 p-4 text-sm text-muted-foreground">
          {t("settings.infraBilling.pickASite")}
        </Card>
      )}

      {truncated && (
        <Card className="mx-4 p-4 text-sm text-muted-foreground">
          {t("settings.infraBilling.tooManySites", {
            count: String(MAX_SELECTED_SITES),
          })}
        </Card>
      )}

      {data?.usageUnavailable && (
        <Card className="mx-4 p-4 text-sm text-muted-foreground">
          {t("settings.infraBilling.warehouseUnavailable")}
        </Card>
      )}

      <SettingsSection title={t("settings.infraBilling.summaryTitle")}>
        <div className="flex flex-col lg:flex-row gap-4 px-4">
          <Card className="flex-1 flex flex-col gap-4 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CreditCard01 size={16} className="text-muted-foreground" />
                <span className="text-sm font-medium">
                  {t("settings.infraBilling.detailsTitle")}
                </span>
              </div>
              {billing?.canManageSubscription && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={portal.isPending}
                  onClick={() => portal.mutate(selected)}
                >
                  {t("settings.infraBilling.manageButton")}
                </Button>
              )}
            </div>
            <div className="flex flex-col gap-2 text-sm">
              {billing ? (
                <>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">
                      {t("settings.infraBilling.currentPlan")}
                    </span>
                    {isLoading ? (
                      <Skeleton className="h-5 w-16" />
                    ) : (
                      <Badge
                        variant={
                          billing.planType === "free" ? "secondary" : "success"
                        }
                      >
                        {t(`settings.infraBilling.plan.${billing.planType}`)}
                      </Badge>
                    )}
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">
                      {t("settings.infraBilling.nextBilling")}
                    </span>
                    <span className="font-medium tabular-nums">
                      {billing.nextBillingDate
                        ? new Date(
                            `${billing.nextBillingDate}T00:00:00Z`,
                          ).toLocaleDateString(undefined, {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                            timeZone: "UTC",
                          })
                        : "—"}
                    </span>
                  </div>
                </>
              ) : (
                !isLoading && (
                  <p className="text-xs text-muted-foreground">
                    {billingMessage}
                  </p>
                )
              )}
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">
                  {t("settings.infraBilling.requestsPerPageview")}
                </span>
                <span className="font-medium tabular-nums">{requestRatio}</span>
              </div>
            </div>
          </Card>

          {metrics.map((metric) => (
            <Card key={metric.key} className="flex-1 flex flex-col gap-2 p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{metric.title}</span>
                <span className="text-xs text-muted-foreground">
                  {months.find((m) => m.value === period)?.label}
                </span>
              </div>
              {isLoading ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <span className="text-2xl font-semibold tabular-nums">
                  {metric.total}
                </span>
              )}
              <div className="-mx-2">
                <UsageChart
                  usage={usage}
                  metric={metric.key}
                  colorNum={metric.colorNum}
                  formatValue={formatFor(metric.key)}
                  height={64}
                />
              </div>
            </Card>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.infraBilling.metricsTitle")}>
        <div className="flex flex-col xl:flex-row gap-4 px-4">
          {metrics.map((metric) => (
            <Card key={metric.key} className="flex-1 flex flex-col gap-3 p-4">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">{metric.title}</span>
                <span className="text-xs text-muted-foreground">
                  {metric.description}
                </span>
              </div>
              <UsageChart
                usage={usage}
                metric={metric.key}
                colorNum={metric.colorNum}
                formatValue={formatFor(metric.key)}
                height={220}
              />
            </Card>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.infraBilling.invoicesTitle")}>
        <Card className="mx-4 overflow-x-auto">
          {!data ? (
            <Skeleton className="m-4 h-24" />
          ) : (billing?.invoices.length ?? 0) === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {billing ? t("settings.infraBilling.noInvoices") : billingMessage}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {t("settings.infraBilling.invoiceReference")}
                  </TableHead>
                  <TableHead>{t("settings.infraBilling.invoiceDue")}</TableHead>
                  <TableHead>
                    {t("settings.infraBilling.invoiceAmount")}
                  </TableHead>
                  <TableHead>
                    {t("settings.infraBilling.invoiceStatus")}
                  </TableHead>
                  <TableHead>
                    {t("settings.infraBilling.invoiceDocuments")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(billing?.invoices ?? []).map((invoice) => (
                  <TableRow key={invoice.id}>
                    <TableCell>
                      {invoice.referenceMonth
                        ? utcDay(invoice.referenceMonth).toLocaleDateString(
                            undefined,
                            { month: "long", year: "numeric", timeZone: "UTC" },
                          )
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {invoice.dueDate
                        ? utcDay(invoice.dueDate).toLocaleDateString(
                            undefined,
                            {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                              timeZone: "UTC",
                            },
                          )
                        : "—"}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {CURRENCY_FMT.format(invoice.value)}
                    </TableCell>
                    <TableCell>
                      <InvoiceStatus status={invoice.status} />
                    </TableCell>
                    <TableCell className="flex gap-2">
                      {invoice.nfUrl && (
                        <DocumentLink
                          href={invoice.nfUrl}
                          label={t("settings.infraBilling.invoiceNf")}
                        />
                      )}
                      {invoice.bankSlipUrl && (
                        <DocumentLink
                          href={invoice.bankSlipUrl}
                          label={t("settings.infraBilling.invoiceBankSlip")}
                        />
                      )}
                      {!invoice.bankSlipUrl &&
                        !teamUsesBankSlip &&
                        invoice.nfUrl && (
                          <DocumentLink
                            href={BANK_TRANSFER_PDF_URL}
                            label={t(
                              "settings.infraBilling.invoiceBankTransfer",
                            )}
                          />
                        )}
                      {!invoice.nfUrl && !invoice.bankSlipUrl && "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </SettingsSection>
    </div>
  );
}

/** A downloadable invoice document — an outline button so it reads as an
 *  action, not as the plain text in the cell next to it. */
function DocumentLink({ href, label }: { href: string; label: string }) {
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={href} target="_blank" rel="noreferrer">
        <LinkExternal01 size={14} />
        {label}
      </a>
    </Button>
  );
}

/** Status comes from the legacy mirror in mixed casing; normalize to compare. */
function InvoiceStatus({ status }: { status: string }) {
  const t = useT();
  const normalized = status.toLowerCase();
  if (normalized === "paid") {
    return (
      <Badge variant="success">{t("settings.infraBilling.statusPaid")}</Badge>
    );
  }
  if (normalized === "overdue") {
    return (
      <Badge variant="destructive">
        {t("settings.infraBilling.statusOverdue")}
      </Badge>
    );
  }
  if (normalized === "registered") {
    return (
      <Badge variant="warning">
        {t("settings.infraBilling.statusPending")}
      </Badge>
    );
  }
  return <Badge variant="secondary">{status}</Badge>;
}

export function OrgInfraBillingPage() {
  const t = useT();
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>{t("settings.infraBilling.pageTitle")}</Page.Title>
            <InfraBillingContent />
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
