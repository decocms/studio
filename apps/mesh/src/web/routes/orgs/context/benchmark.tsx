/**
 * Benchmark context page — /$org/$project/benchmark
 *
 * Shows competitor comparison table, own stats, and an Agent Monitor card.
 */

import { Page } from "@/web/components/page";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import { TrendUp01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";

// ─── Data ─────────────────────────────────────────────────────────────────────

const COMPETITORS = [
  {
    domain: "animale.com.br",
    traffic: "1.8M",
    delta: -14,
    techStack: ["VTEX"],
  },
  {
    domain: "amaro.com",
    traffic: "2.4M",
    delta: +15,
    techStack: ["Shopify"],
  },
  {
    domain: "crisbarros.com.br",
    traffic: "890K",
    delta: -57,
    techStack: ["VTEX"],
  },
  {
    domain: "roupas.com.br",
    traffic: "3.1M",
    delta: +48,
    techStack: ["Custom"],
  },
];

const OWN_STATS = { traffic: "2.1M", bounce: "41%", pagesPerVisit: "4.2" };

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function BenchmarkPage() {
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
                <BreadcrumbPage>Benchmark</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
        <Page.Header.Right>
          <button
            type="button"
            onClick={() =>
              navigate({
                to: "/$org/$project/triggers",
                params: { org: org.slug, project: project.slug },
              })
            }
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Last checked 2h ago →
          </button>
          <Button variant="outline" size="sm" className="h-7 text-xs">
            Run check
          </Button>
        </Page.Header.Right>
      </Page.Header>

      <Page.Content className="h-full overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8 grid grid-cols-[1fr_280px] gap-8">
          {/* Left column */}
          <div className="flex flex-col gap-6">
            {/* Own stats header */}
            <div className="rounded-lg border border-border bg-muted/50 px-4 py-3">
              <p className="text-xs font-medium text-foreground">
                Your site:{" "}
                <span className="font-semibold">{OWN_STATS.traffic}</span>{" "}
                visits/mo &middot;{" "}
                <span className="font-semibold">{OWN_STATS.bounce}</span> bounce
                &middot;{" "}
                <span className="font-semibold">{OWN_STATS.pagesPerVisit}</span>{" "}
                pages/visit
              </p>
            </div>

            {/* Competitors table */}
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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
                    <th className="pb-2 text-right text-xs font-medium text-muted-foreground">
                      Tech
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {COMPETITORS.map((c) => (
                    <tr key={c.domain} className="border-b border-border/30">
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
                      <td className="py-2.5 text-right">
                        <span
                          className={cn(
                            "text-xs font-semibold",
                            c.delta > 0 ? "text-red-500" : "text-green-600",
                          )}
                        >
                          {c.delta > 0 ? "+" : ""}
                          {c.delta}%
                        </span>
                      </td>
                      <td className="py-2.5 text-right">
                        <div className="flex justify-end gap-1 flex-wrap">
                          {c.techStack.map((t) => (
                            <span
                              key={t}
                              className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Insight card */}
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2">
              <TrendUp01 size={14} className="text-amber-600 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-800 leading-relaxed">
                <span className="font-semibold">amaro.com</span> and{" "}
                <span className="font-semibold">roupas.com.br</span> are growing
                faster than you this month.
              </p>
            </div>
          </div>

          {/* Right column */}
          <div className="flex flex-col gap-4">
            {/* Agent Monitor card — coming soon */}
            <div className="rounded-xl border border-border p-4 flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <div className="size-9 rounded-lg bg-violet-100 text-violet-600 flex items-center justify-center shrink-0">
                  <TrendUp01 size={17} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold">Competitor Tracker</p>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      Coming soon
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Weekly competitive intelligence
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Monitors competitor pricing, content launches, and traffic
                trends. Alerts you when rivals make moves that could impact your
                market position.
              </p>
            </div>

            {/* Reports timeline */}
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Recent reports
              </p>
              {[
                {
                  date: "Feb 25, 2026",
                  title: "amaro.com launched new collection page",
                  dot: "bg-blue-500",
                },
                {
                  date: "Feb 18, 2026",
                  title: "roupas.com.br reduced prices on 3 categories",
                  dot: "bg-amber-500",
                },
              ].map((r) => (
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
