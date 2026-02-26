/**
 * Performance context page — /$org/$project/performance
 *
 * Shows Core Web Vitals, performance findings, and an Agent Monitor card.
 */

import { Page } from "@/web/components/page";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import {
  AlertCircle,
  ArrowRight,
  BarChart10,
  InfoCircle,
} from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";

// ─── Data ─────────────────────────────────────────────────────────────────────

type VitalStatus = "poor" | "needs";

const VITALS: {
  metric: string;
  value: string;
  status: VitalStatus;
  threshold: string;
}[] = [
  { metric: "LCP", value: "4.2s", status: "poor", threshold: "< 2.5s" },
  { metric: "CLS", value: "0.18", status: "needs", threshold: "< 0.1" },
  { metric: "INP", value: "220ms", status: "needs", threshold: "< 200ms" },
];

type Severity = "critical" | "warning" | "info";

const ISSUES: {
  id: number;
  severity: Severity;
  text: string;
  impact: string;
}[] = [
  {
    id: 1,
    severity: "critical",
    text: "38% drop-off between shipping → payment — industry avg is 22%",
    impact: "~$45K/yr",
  },
  {
    id: 2,
    severity: "critical",
    text: "Purchase event missing transaction_id on 23% of checkouts",
    impact: "~$45K/yr",
  },
  {
    id: 3,
    severity: "warning",
    text: "23 product pages missing meta descriptions",
    impact: "-$29K/yr",
  },
  {
    id: 4,
    severity: "warning",
    text: "404 on /collections/winter-sale — receiving 230 hits/hr",
    impact: "~$45K/yr",
  },
  {
    id: 5,
    severity: "info",
    text: "Newsletter popup fires immediately on mobile — 62% close rate",
    impact: "~$45K/yr",
  },
  {
    id: 6,
    severity: "info",
    text: "Hero images not optimized — adding 2.1s to load time",
    impact: "~$45K/yr",
  },
];

const REPORTS = [
  {
    date: "Feb 25, 2026",
    title: "LCP improved to 3.8s after image optimization",
    dot: "bg-emerald-500",
  },
  {
    date: "Feb 18, 2026",
    title: "3 new critical issues detected",
    dot: "bg-red-500",
  },
  {
    date: "Feb 11, 2026",
    title: "Weekly check — no regressions",
    dot: "bg-muted-foreground/40",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function SeverityIcon({ severity }: { severity: Severity }) {
  if (severity === "critical") {
    return (
      <div className="shrink-0 flex items-center justify-center size-6 rounded-full bg-red-50 border border-red-200">
        <AlertCircle size={12} className="text-red-500" />
      </div>
    );
  }
  if (severity === "warning") {
    return (
      <div className="shrink-0 flex items-center justify-center size-6 rounded-full bg-orange-50 border border-orange-200">
        <AlertCircle size={12} className="text-orange-500" />
      </div>
    );
  }
  return (
    <div className="shrink-0 flex items-center justify-center size-6 rounded-full bg-blue-50 border border-blue-200">
      <InfoCircle size={12} className="text-blue-500" />
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function PerformancePage() {
  const { org, project } = useProjectContext();
  const navigate = useNavigate();

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <span className="text-sm text-muted-foreground">Context</span>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>Performance</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
        <Page.Header.Right>
          <span className="text-xs text-muted-foreground">
            Last checked 2h ago
          </span>
          <Button variant="outline" size="sm" className="h-7 text-xs">
            Run check
          </Button>
        </Page.Header.Right>
      </Page.Header>

      <Page.Content className="h-full overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8 grid grid-cols-[1fr_280px] gap-8">
          {/* Left column */}
          <div className="flex flex-col gap-6">
            {/* Score */}
            <div className="flex items-center gap-5">
              <div className="flex shrink-0 flex-col items-center justify-center size-20 rounded-full border-4 border-orange-400 bg-orange-50">
                <span className="text-2xl font-bold text-orange-500">42</span>
                <span className="text-[10px] text-muted-foreground">/100</span>
              </div>
              <div>
                <p className="font-semibold text-sm text-foreground">
                  Needs attention
                </p>
                <p className="text-xs text-muted-foreground">
                  Slower than 72% of e-commerce sites
                </p>
              </div>
            </div>

            {/* Core Web Vitals */}
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Core Web Vitals
              </p>
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
                    <th className="pb-2 text-left text-xs font-medium text-muted-foreground">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {VITALS.map((v) => (
                    <tr key={v.metric} className="border-b border-border/30">
                      <td className="py-2.5 text-sm font-semibold">
                        {v.metric}
                      </td>
                      <td
                        className={cn(
                          "py-2.5 text-sm font-medium",
                          v.status === "poor"
                            ? "text-red-500"
                            : "text-amber-500",
                        )}
                      >
                        {v.value}
                      </td>
                      <td className="py-2.5 text-xs text-muted-foreground">
                        {v.threshold}
                      </td>
                      <td className="py-2.5">
                        {v.status === "poor" ? (
                          <span className="flex items-center gap-1 text-xs text-red-500">
                            <div className="size-1.5 rounded-full bg-red-500" />
                            Poor
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-amber-500">
                            <div className="size-1.5 rounded-full bg-amber-400" />
                            Needs work
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Findings */}
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Findings
              </p>
              <div className="flex flex-col">
                {ISSUES.map((issue) => (
                  <div
                    key={issue.id}
                    className="flex items-start gap-3 border-b border-border/30 py-3 last:border-0"
                  >
                    <SeverityIcon severity={issue.severity} />
                    <p className="flex-1 text-xs text-foreground leading-relaxed">
                      {issue.text}
                    </p>
                    <span className="shrink-0 text-xs font-medium text-red-500">
                      {issue.impact}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right column */}
          <div className="flex flex-col gap-4">
            {/* Agent Monitor card */}
            <div className="rounded-xl border border-border p-4 flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <div className="size-9 rounded-lg bg-orange-100 text-orange-600 flex items-center justify-center shrink-0">
                  <BarChart10 size={17} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">Performance Monitor</p>
                  <p className="text-xs text-muted-foreground">
                    Daily Core Web Vitals checks
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Watches LCP, CLS, and INP daily. Surfaces regressions before
                they hurt conversions and auto-files tasks for fixes.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() =>
                  navigate({
                    to: "/$org/$project/hire/$agentId",
                    params: {
                      org: org.slug,
                      project: project,
                      agentId: "performance-monitor",
                    },
                  })
                }
              >
                Hire this agent
                <ArrowRight size={13} />
              </Button>
            </div>

            {/* Reports timeline */}
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Recent reports
              </p>
              {REPORTS.map((r) => (
                <div
                  key={r.date}
                  className="flex items-start gap-2.5 py-2 border-b border-border/40 last:border-0"
                >
                  <div
                    className={cn(
                      "size-1.5 rounded-full mt-1.5 shrink-0",
                      r.dot,
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground">
                      {r.title}
                    </p>
                    <p className="text-xs text-muted-foreground">{r.date}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Page.Content>
    </Page>
  );
}
