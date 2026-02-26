/**
 * Reputation context page — /$org/$project/reputation
 *
 * Shows reputation score, sentiment breakdown, complaint themes, and an Agent Monitor card.
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
import { Globe02 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";

// ─── Data ─────────────────────────────────────────────────────────────────────

const REP = {
  score: 7.2,
  reviews: 1234,
  responseRate: 89,
  avgResolution: "2.1 days",
  sentiment: { positive: 62, neutral: 24, negative: 14 },
  themes: [
    { label: "Shipping delays", pct: 34 },
    { label: "Return process", pct: 22 },
    { label: "Product quality", pct: 18 },
    { label: "Customer support", pct: 15 },
    { label: "Other", pct: 11 },
  ],
};

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function ReputationPage() {
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
                <BreadcrumbPage>Reputation</BreadcrumbPage>
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
              <div className="flex shrink-0 flex-col items-center justify-center size-20 rounded-full border-4 border-green-400 bg-green-50">
                <span className="text-2xl font-bold text-green-600">
                  {REP.score}
                </span>
                <span className="text-[10px] text-muted-foreground">/10</span>
              </div>
              <div className="flex flex-col gap-1">
                <p className="font-semibold text-sm text-foreground">
                  Good reputation
                </p>
                <div className="flex gap-4 text-xs text-muted-foreground">
                  <span>{REP.reviews.toLocaleString()} reviews</span>
                  <span>{REP.responseRate}% response rate</span>
                  <span>avg. {REP.avgResolution} resolution</span>
                </div>
              </div>
            </div>

            {/* Sentiment */}
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Sentiment breakdown
              </p>
              <div className="flex flex-col gap-2.5">
                {[
                  {
                    label: "Positive",
                    pct: REP.sentiment.positive,
                    color: "bg-green-500",
                  },
                  {
                    label: "Neutral",
                    pct: REP.sentiment.neutral,
                    color: "bg-muted-foreground/30",
                  },
                  {
                    label: "Negative",
                    pct: REP.sentiment.negative,
                    color: "bg-red-400",
                  },
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

            {/* Complaint themes */}
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Top complaint themes
              </p>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border/50">
                    <th className="pb-2 text-left text-xs font-medium text-muted-foreground">
                      Theme
                    </th>
                    <th className="pb-2 text-right text-xs font-medium text-muted-foreground">
                      Share
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {REP.themes.map((t) => (
                    <tr key={t.label} className="border-b border-border/30">
                      <td className="py-2.5 text-xs font-medium">{t.label}</td>
                      <td className="py-2.5 text-xs text-right text-muted-foreground">
                        {t.pct}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right column */}
          <div className="flex flex-col gap-4">
            {/* Agent Monitor card — placeholder */}
            <div className="rounded-xl border border-border p-4 flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <div className="size-9 rounded-lg bg-green-100 text-green-600 flex items-center justify-center shrink-0">
                  <Globe02 size={17} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">Reputation Monitor</p>
                  <p className="text-xs text-muted-foreground">No agent yet</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                No agent is currently monitoring your reputation. An agent could
                track reviews, flag sentiment drops, and escalate unresolved
                complaints automatically.
              </p>
              <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2">
                <p className="text-xs text-muted-foreground text-center">
                  Coming soon
                </p>
              </div>
            </div>

            {/* Reports timeline — empty */}
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Recent reports
              </p>
              <p className="text-xs text-muted-foreground">
                No reports yet. Hire an agent to start monitoring.
              </p>
            </div>
          </div>
        </div>
      </Page.Content>
    </Page>
  );
}
