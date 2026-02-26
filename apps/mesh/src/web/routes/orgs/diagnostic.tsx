/**
 * Diagnostic route — /$org/$project/diagnostic
 *
 * Shows the storefront diagnostic report for this org/project.
 * Owners can toggle public/private visibility.
 */

import { Page } from "@/web/components/page";
import { cn } from "@deco/ui/lib/utils.ts";
import { Button } from "@deco/ui/components/button.tsx";
import { useState } from "react";
import { useProjectContext } from "@decocms/mesh-sdk";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  Globe01,
  Lock01,
  RefreshCcw01,
} from "@untitledui/icons";

// ─── Data (Farmrio diagnostic) ────────────────────────────────────────────────

const SCORES = [
  { label: "PageSpeed", value: 42, max: 100 },
  { label: "SEO", value: 67, max: 100 },
  { label: "Errors", value: 12, max: null },
  { label: "Conversion", value: 2, max: 100 },
];

type Severity = "critical" | "warning" | "info";

const ISSUES: { severity: Severity; text: string; cost: string | null }[] = [
  {
    severity: "critical",
    text: "38% drop-off between shipping → payment step — industry avg is 22%",
    cost: "~$45K/yr",
  },
  {
    severity: "critical",
    text: "Purchase event missing transaction_id on 23% of checkouts — GA4 revenue data is unreliable",
    cost: "~$45K/yr",
  },
  {
    severity: "warning",
    text: "23 product pages missing meta descriptions — CTR drops ~30% without them",
    cost: "~$29K/yr",
  },
  {
    severity: "warning",
    text: "404 on /collections/winter-sale — receiving 230 hits/hr from Google organic",
    cost: "~$45K/yr",
  },
  {
    severity: "info",
    text: "Newsletter popup fires immediately on mobile — 62% close rate, 18% exit rate",
    cost: "~$45K/yr",
  },
  {
    severity: "info",
    text: "Hero images not optimized — adding 2.1s to load time on landing pages",
    cost: "~$45K/yr",
  },
];

const COMPANY = {
  description:
    "Brazilian fashion brand known for bold tropical prints and sustainable sourcing. Direct-to-consumer e-commerce with strong presence across Brazil, US, and Europe.",
  brandColors: ["#1B5E20", "#F4E9D1", "#C8102E", "#2C2C2C"],
  techStack: [
    "VTEX",
    "Google Tag Manager",
    "Hotjar",
    "TrustVox",
    "Zendesk Chat",
    "Facebook Pixel",
    "Google Ads",
  ],
  traffic: { monthly: "2.1M", bounce: "41%", duration: "3m 42s" },
  organic: "380K/mo",
  backlinks: "12.4K",
  authorityScore: "34/100",
  reputation: { score: 7.2, reviews: 1234, responseRate: 89 },
  competitors: [
    { domain: "animale.com.br", traffic: "1.8M", delta: -14 },
    { domain: "amaro.com", traffic: "2.4M", delta: +15 },
    { domain: "crisbarros.com.br", traffic: "890K", delta: -57 },
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scoreColor(value: number): string {
  if (value >= 80) return "text-emerald-600";
  if (value >= 50) return "text-amber-500";
  return "text-red-500";
}

function scoreBg(value: number): string {
  if (value >= 80) return "bg-emerald-50 border-emerald-100";
  if (value >= 50) return "bg-amber-50 border-amber-100";
  return "bg-red-50 border-red-100";
}

function SeverityDot({ severity }: { severity: Severity }) {
  if (severity === "critical")
    return (
      <div className="shrink-0 flex items-center justify-center size-6 rounded-full bg-red-50 border border-red-200">
        <AlertCircle size={12} className="text-red-500" />
      </div>
    );
  if (severity === "warning")
    return (
      <div className="shrink-0 flex items-center justify-center size-6 rounded-full bg-amber-50 border border-amber-200">
        <AlertTriangle size={12} className="text-amber-500" />
      </div>
    );
  return (
    <div className="shrink-0 flex items-center justify-center size-6 rounded-full bg-blue-50 border border-blue-200">
      <CheckCircle size={12} className="text-blue-500" />
    </div>
  );
}

type Tab = "overview" | "performance" | "seo" | "reputation";

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function DiagnosticPage() {
  const { org } = useProjectContext();
  const [isPublic, setIsPublic] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  const displayDomain = org.slug.replace(/-/g, ".").toLowerCase();
  const criticalCount = ISSUES.filter((i) => i.severity === "critical").length;
  const totalRevAtRisk = "$11.9M/yr";

  const TABS: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "performance", label: "Performance" },
    { key: "seo", label: "SEO" },
    { key: "reputation", label: "Reputation" },
  ];

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <img
            src={`https://www.google.com/s2/favicons?domain=${displayDomain}&sz=32`}
            className="size-4 rounded-sm"
            alt=""
          />
          <span className="text-sm font-medium text-foreground">
            Diagnostic
          </span>
          <span className="text-xs text-muted-foreground font-mono">
            {displayDomain}
          </span>
        </Page.Header.Left>
        <Page.Header.Right className="gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsPublic((v) => !v)}
            className="h-7 gap-1.5 text-xs"
          >
            {isPublic ? (
              <>
                <Globe01 size={13} />
                Public
              </>
            ) : (
              <>
                <Lock01 size={13} />
                Private
              </>
            )}
          </Button>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
            <RefreshCcw01 size={13} />
            Re-run
          </Button>
        </Page.Header.Right>
      </Page.Header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-8 flex flex-col gap-6">
          {/* Scores */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {SCORES.map((score) => (
              <div
                key={score.label}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-xl border px-4 py-4",
                  scoreBg(score.value),
                )}
              >
                <span
                  className={cn(
                    "font-mono text-3xl font-bold tabular-nums",
                    scoreColor(score.value),
                  )}
                >
                  {score.value}
                  {score.max && (
                    <span className="text-base font-normal opacity-40">
                      /{score.max}
                    </span>
                  )}
                </span>
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {score.label}
                </span>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="flex border-b border-border px-2">
              {TABS.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={cn(
                    "px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px",
                    activeTab === key
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="p-6">
              {/* Overview */}
              {activeTab === "overview" && (
                <div className="flex flex-col gap-5">
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {COMPANY.description}
                  </p>
                  <div className="grid grid-cols-2 gap-5">
                    <div className="flex flex-col gap-2">
                      <p className="text-[11px] font-mono uppercase tracking-wide text-muted-foreground">
                        Brand Colors
                      </p>
                      <div className="flex gap-2">
                        {COMPANY.brandColors.map((c) => (
                          <div
                            key={c}
                            className="size-7 rounded-lg border border-border shadow-sm"
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-col gap-2">
                      <p className="text-[11px] font-mono uppercase tracking-wide text-muted-foreground">
                        Traffic
                      </p>
                      <div className="flex gap-4">
                        <div>
                          <p className="font-semibold text-sm">
                            {COMPANY.traffic.monthly}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            visits/mo
                          </p>
                        </div>
                        <div>
                          <p className="font-semibold text-sm">
                            {COMPANY.traffic.bounce}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            bounce
                          </p>
                        </div>
                        <div>
                          <p className="font-semibold text-sm">
                            {COMPANY.traffic.duration}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            avg. dur.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <p className="text-[11px] font-mono uppercase tracking-wide text-muted-foreground">
                      Tech Stack
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {COMPANY.techStack.map((t) => (
                        <span
                          key={t}
                          className="rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <p className="text-[11px] font-mono uppercase tracking-wide text-muted-foreground">
                      Competitors
                    </p>
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border/50">
                          <th className="pb-2 text-left text-xs font-medium text-muted-foreground">
                            Site
                          </th>
                          <th className="pb-2 text-right text-xs font-medium text-muted-foreground">
                            Traffic/mo
                          </th>
                          <th className="pb-2 text-right text-xs font-medium text-muted-foreground">
                            vs you
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {COMPANY.competitors.map((c) => (
                          <tr
                            key={c.domain}
                            className="border-b border-border/30"
                          >
                            <td className="py-2.5">
                              <div className="flex items-center gap-2">
                                <img
                                  src={`https://www.google.com/s2/favicons?domain=${c.domain}&sz=32`}
                                  className="size-4 rounded-sm"
                                  alt=""
                                />
                                <span className="text-xs font-medium">
                                  {c.domain}
                                </span>
                              </div>
                            </td>
                            <td className="py-2.5 text-xs text-right text-muted-foreground">
                              {c.traffic}
                            </td>
                            <td
                              className={cn(
                                "py-2.5 text-xs text-right font-semibold",
                                c.delta > 0 ? "text-red-500" : "text-green-600",
                              )}
                            >
                              {c.delta > 0 ? "+" : ""}
                              {c.delta}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Performance */}
              {activeTab === "performance" && (
                <div className="flex flex-col gap-5">
                  <div className="flex items-center gap-5">
                    <div className="flex shrink-0 flex-col items-center justify-center size-20 rounded-full border-4 border-orange-400 bg-orange-50">
                      <span className="text-2xl font-bold text-orange-500">
                        42
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        /100
                      </span>
                    </div>
                    <div>
                      <p className="font-semibold text-sm">Needs attention</p>
                      <p className="text-xs text-muted-foreground">
                        Slower than 72% of e-commerce sites in your segment
                      </p>
                    </div>
                  </div>
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border/50">
                        <th className="pb-2 text-left text-xs font-medium text-muted-foreground">
                          Metric
                        </th>
                        <th className="pb-2 text-left text-xs font-medium text-muted-foreground">
                          Value
                        </th>
                        <th className="pb-2 text-left text-xs font-medium text-muted-foreground">
                          Target
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        {
                          metric: "LCP",
                          value: "4.2s",
                          threshold: "< 2.5s",
                          bad: true,
                        },
                        {
                          metric: "CLS",
                          value: "0.18",
                          threshold: "< 0.1",
                          bad: true,
                        },
                        {
                          metric: "INP",
                          value: "220ms",
                          threshold: "< 200ms",
                          bad: true,
                        },
                      ].map((v) => (
                        <tr
                          key={v.metric}
                          className="border-b border-border/30"
                        >
                          <td className="py-2.5 text-sm font-semibold">
                            {v.metric}
                          </td>
                          <td
                            className={cn(
                              "py-2.5 text-sm font-medium",
                              v.bad ? "text-red-500" : "text-green-600",
                            )}
                          >
                            {v.value}
                          </td>
                          <td className="py-2.5 text-xs text-muted-foreground">
                            {v.threshold}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="flex flex-col gap-1 pt-2">
                    {ISSUES.map((issue, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-3 border-b border-border/30 py-3"
                      >
                        <SeverityDot severity={issue.severity} />
                        <p className="flex-1 text-xs text-foreground leading-relaxed">
                          {issue.text}
                        </p>
                        {issue.cost && (
                          <span className="shrink-0 text-xs font-medium text-red-500">
                            {issue.cost}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* SEO */}
              {activeTab === "seo" && (
                <div className="flex flex-col gap-5">
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: "Organic Traffic", value: COMPANY.organic },
                      { label: "Backlinks", value: COMPANY.backlinks },
                      {
                        label: "Authority Score",
                        value: COMPANY.authorityScore,
                      },
                    ].map(({ label, value }) => (
                      <div
                        key={label}
                        className="rounded-lg border border-border bg-muted/50 p-3"
                      >
                        <p className="text-xs text-muted-foreground">{label}</p>
                        <p className="text-lg font-semibold mt-0.5">{value}</p>
                      </div>
                    ))}
                  </div>
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border/50">
                        <th className="pb-2 text-left text-xs font-medium text-muted-foreground">
                          Keyword
                        </th>
                        <th className="pb-2 text-right text-xs font-medium text-muted-foreground">
                          Searches/mo
                        </th>
                        <th className="pb-2 text-right text-xs font-medium text-muted-foreground">
                          Position
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { keyword: "farm rio", volume: "90K", position: 1 },
                        {
                          keyword: "vestidos estampados",
                          volume: "34K",
                          position: 3,
                        },
                        {
                          keyword: "moda feminina",
                          volume: "110K",
                          position: 8,
                        },
                        { keyword: "farm rio usa", volume: "18K", position: 2 },
                        {
                          keyword: "vestidos florais",
                          volume: "22K",
                          position: 11,
                        },
                      ].map((kw) => (
                        <tr
                          key={kw.keyword}
                          className="border-b border-border/30"
                        >
                          <td className="py-2.5 text-xs font-medium">
                            {kw.keyword}
                          </td>
                          <td className="py-2.5 text-xs text-right text-muted-foreground">
                            {kw.volume}
                          </td>
                          <td className="py-2.5 text-right">
                            <span
                              className={cn(
                                "text-xs font-semibold",
                                kw.position <= 3
                                  ? "text-green-600"
                                  : kw.position <= 10
                                    ? "text-orange-500"
                                    : "text-muted-foreground",
                              )}
                            >
                              #{kw.position}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Reputation */}
              {activeTab === "reputation" && (
                <div className="flex flex-col gap-5">
                  <div className="flex items-center gap-5">
                    <div className="flex shrink-0 flex-col items-center justify-center size-20 rounded-full border-4 border-green-400 bg-green-50">
                      <span className="text-2xl font-bold text-green-600">
                        {COMPANY.reputation.score}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        /10
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <p className="font-semibold text-sm">Good reputation</p>
                      <div className="flex gap-4 text-xs text-muted-foreground">
                        <span>
                          {COMPANY.reputation.reviews.toLocaleString()} reviews
                        </span>
                        <span>
                          {COMPANY.reputation.responseRate}% response rate
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2.5">
                    {[
                      { label: "Positive", pct: 62, color: "bg-green-500" },
                      {
                        label: "Neutral",
                        pct: 24,
                        color: "bg-muted-foreground/30",
                      },
                      { label: "Negative", pct: 14, color: "bg-red-400" },
                    ].map(({ label, pct, color }) => (
                      <div key={label} className="flex items-center gap-3">
                        <span className="w-14 text-xs text-muted-foreground">
                          {label}
                        </span>
                        <div className="flex-1 rounded-full bg-muted h-1.5 overflow-hidden">
                          <div
                            className={cn("h-full rounded-full", color)}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="w-8 text-right text-xs font-medium">
                          {pct}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Summary + CTA */}
          <div className="rounded-2xl border border-border bg-card px-6 py-5 flex flex-col gap-4">
            <div>
              <p className="text-lg font-semibold text-foreground">
                <span className="text-red-500">{totalRevAtRisk} at risk.</span>{" "}
                Your storefront needs attention.
              </p>
              <div className="mt-1.5 flex items-center gap-3 text-sm text-muted-foreground">
                <span>{criticalCount} critical issues</span>
                <span className="text-border">·</span>
                <span>{ISSUES.length} total findings</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isPublic && (
                <p className="text-xs text-muted-foreground flex-1">
                  This report is publicly visible. Toggle to private to hide it.
                </p>
              )}
              <Button size="sm">Fix issues with AI</Button>
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
