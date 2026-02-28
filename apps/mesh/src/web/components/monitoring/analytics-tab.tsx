/**
 * Analytics Tab Component
 *
 * Displays Top Tools, Top Servers, and Top Agents analytics for the monitoring page.
 */

import { ErrorBoundary } from "@/web/components/error-boundary";
import { Suspense, useState } from "react";
import { TopTools, type TopChartMetric } from "./analytics-top-tools";
import { TopServers, type MetricsMode } from "./analytics-top-servers";
import { TopAgents } from "./analytics-top-agents";

export function AnalyticsTab() {
  const [metricsMode, setMetricsMode] = useState<MetricsMode>("requests");

  return (
    <div className="flex-1 flex flex-col overflow-auto">
      {/* Top Tools - fixed height */}
      <div className="border-b bg-background shrink-0">
        <ErrorBoundary
          fallback={
            <div className="bg-background p-5 text-sm text-muted-foreground">
              Failed to load top tools
            </div>
          }
        >
          <Suspense fallback={<TopTools.Skeleton />}>
            <TopTools.Content
              metricsMode={
                metricsMode === "requests"
                  ? "calls"
                  : (metricsMode as TopChartMetric)
              }
            />
          </Suspense>
        </ErrorBoundary>
      </div>

      {/* Bottom row - takes remaining height */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-[0.5px] bg-border min-h-0">
        {/* Top Servers */}
        <div className="bg-background overflow-auto">
          <ErrorBoundary
            fallback={
              <div className="bg-background p-5 text-sm text-muted-foreground">
                Failed to load top servers
              </div>
            }
          >
            <Suspense fallback={<TopServers.Skeleton />}>
              <TopServers.Content
                metricsMode={metricsMode}
                onMetricsModeChange={setMetricsMode}
              />
            </Suspense>
          </ErrorBoundary>
        </div>

        {/* Top Agents */}
        <div className="bg-background overflow-auto">
          <ErrorBoundary
            fallback={
              <div className="bg-background p-5 text-sm text-muted-foreground">
                Failed to load top agents
              </div>
            }
          >
            <Suspense fallback={<TopAgents.Skeleton />}>
              <TopAgents.Content metricsMode={metricsMode} />
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
