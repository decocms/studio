/**
 * Benchmark Report Generator
 *
 * Generates markdown reports from benchmark results.
 */

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type {
  AggregatedResult,
  BenchmarkReport,
  BenchmarkResult,
  VirtualMCPtoolSelectionStrategy,
} from "./types";

/**
 * Aggregate results by strategy, tool count, and model
 */
function aggregateResults(results: BenchmarkResult[]): AggregatedResult[] {
  const groups = new Map<string, BenchmarkResult[]>();

  // Group by strategy + toolCount + model
  for (const result of results) {
    const key = `${result.scenario.strategy}|${result.scenario.toolCount}|${result.scenario.model}`;
    const group = groups.get(key) || [];
    group.push(result);
    groups.set(key, group);
  }

  // Calculate aggregates
  const aggregated: AggregatedResult[] = [];

  for (const [key, group] of groups) {
    const [strategy, toolCount, model] = key.split("|");
    const successCount = group.filter((r) => r.success).length;

    aggregated.push({
      strategy: strategy as VirtualMCPtoolSelectionStrategy,
      toolCount: parseInt(toolCount, 10),
      model,
      avgInputTokens: Math.round(
        group.reduce((sum, r) => sum + r.inputTokens, 0) / group.length,
      ),
      avgOutputTokens: Math.round(
        group.reduce((sum, r) => sum + r.outputTokens, 0) / group.length,
      ),
      avgTotalTokens: Math.round(
        group.reduce((sum, r) => sum + r.totalTokens, 0) / group.length,
      ),
      avgMessageCount: Math.round(
        group.reduce((sum, r) => sum + r.messageCount, 0) / group.length,
      ),
      avgDurationMs: Math.round(
        group.reduce((sum, r) => sum + r.durationMs, 0) / group.length,
      ),
      successRate: Math.round((successCount / group.length) * 100),
      sampleCount: group.length,
    });
  }

  // Sort by strategy, then tool count
  return aggregated.sort((a, b) => {
    if (a.strategy !== b.strategy) {
      return a.strategy.localeCompare(b.strategy);
    }
    return a.toolCount - b.toolCount;
  });
}

/**
 * Aggregate results by strategy and tool count only (for dashboard)
 * This averages across all models and task types
 */
function aggregateForDashboard(results: BenchmarkResult[]): AggregatedResult[] {
  const groups = new Map<string, BenchmarkResult[]>();

  // Group by strategy + toolCount only (not model)
  for (const result of results) {
    const key = `${result.scenario.strategy}|${result.scenario.toolCount}`;
    const group = groups.get(key) || [];
    group.push(result);
    groups.set(key, group);
  }

  // Calculate aggregates
  const aggregated: AggregatedResult[] = [];

  for (const [key, group] of groups) {
    const [strategy, toolCount] = key.split("|");
    const successCount = group.filter((r) => r.success).length;

    aggregated.push({
      strategy: strategy as VirtualMCPtoolSelectionStrategy,
      toolCount: parseInt(toolCount, 10),
      model: "all", // Aggregated across all models
      avgInputTokens: Math.round(
        group.reduce((sum, r) => sum + r.inputTokens, 0) / group.length,
      ),
      avgOutputTokens: Math.round(
        group.reduce((sum, r) => sum + r.outputTokens, 0) / group.length,
      ),
      avgTotalTokens: Math.round(
        group.reduce((sum, r) => sum + r.totalTokens, 0) / group.length,
      ),
      avgMessageCount: Math.round(
        group.reduce((sum, r) => sum + r.messageCount, 0) / group.length,
      ),
      avgDurationMs: Math.round(
        group.reduce((sum, r) => sum + r.durationMs, 0) / group.length,
      ),
      successRate: Math.round((successCount / group.length) * 100),
      sampleCount: group.length,
    });
  }

  // Sort by tool count, then strategy
  return aggregated.sort((a, b) => {
    if (a.toolCount !== b.toolCount) {
      return a.toolCount - b.toolCount;
    }
    return a.strategy.localeCompare(b.strategy);
  });
}

/**
 * Format a number with commas
 */
function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Calculate token savings compared to passthrough
 */
function calculateSavingsVsPassthrough(
  aggregated: AggregatedResult[],
): Map<string, number> {
  const savings = new Map<string, number>();

  // Get passthrough results by tool count
  const passthroughByToolCount = new Map<number, number>();
  for (const agg of aggregated) {
    if (agg.strategy === "passthrough") {
      passthroughByToolCount.set(agg.toolCount, agg.avgTotalTokens);
    }
  }

  // Calculate savings for each strategy/toolCount
  for (const agg of aggregated) {
    const passthroughTokens = passthroughByToolCount.get(agg.toolCount);
    if (passthroughTokens && agg.strategy !== "passthrough") {
      const savingsPercent = Math.round(
        ((passthroughTokens - agg.avgTotalTokens) / passthroughTokens) * 100,
      );
      savings.set(`${agg.strategy}|${agg.toolCount}`, savingsPercent);
    }
  }

  return savings;
}

/**
 * Generate ASCII bar chart
 */
function generateBarChart(
  data: Array<{ label: string; value: number; maxValue: number }>,
  maxWidth: number = 40,
): string[] {
  const lines: string[] = [];

  for (const item of data) {
    const barLength = Math.round((item.value / item.maxValue) * maxWidth);
    const bar = "█".repeat(Math.max(1, barLength));
    const padding = " ".repeat(Math.max(0, maxWidth - barLength));
    lines.push(
      `${item.label.padEnd(25)} ${bar}${padding} ${formatNumber(item.value)}`,
    );
  }

  return lines;
}

/**
 * Generate the markdown report content
 */
function generateMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];

  // Use dashboard aggregation (across all models/tasks) for the main dashboard
  const dashboardAgg = aggregateForDashboard(report.results);
  const savings = calculateSavingsVsPassthrough(dashboardAgg);

  // Header
  lines.push("# MCP Gateway Benchmark Results");
  lines.push("");
  lines.push(`**Generated:** ${report.timestamp.toISOString()}`);
  lines.push(`**Total Duration:** ${formatNumber(report.totalDurationMs)}ms`);
  lines.push(`**Scenarios Run:** ${report.results.length}`);
  lines.push("");

  // Dashboard Section
  lines.push("## 📊 Dashboard");
  lines.push("");
  lines.push("*Averaged across all models and task types*");
  lines.push("");

  // Get unique tool counts
  const toolCounts = [...new Set(dashboardAgg.map((a) => a.toolCount))].sort(
    (a, b) => a - b,
  );

  // Generate dashboard for each tool count
  for (const tc of toolCounts) {
    const resultsForTc = dashboardAgg.filter((a) => a.toolCount === tc);
    if (resultsForTc.length === 0) continue;

    const maxTokens = Math.max(...resultsForTc.map((r) => r.avgTotalTokens));

    lines.push(`### ${tc} Tools`);
    lines.push("");
    lines.push("```");

    const chartData = resultsForTc.map((r) => {
      const savingsKey = `${r.strategy}|${tc}`;
      const savingsPercent = savings.get(savingsKey);
      const savingsStr =
        savingsPercent !== undefined
          ? savingsPercent > 0
            ? ` (↓${savingsPercent}%)`
            : savingsPercent < 0
              ? ` (↑${Math.abs(savingsPercent)}%)`
              : ""
          : "";
      // Display passthrough as "baseline"
      const strategyName =
        r.strategy === "passthrough" ? "baseline" : r.strategy;
      return {
        label: `${strategyName}${savingsStr}`,
        value: r.avgTotalTokens,
        maxValue: maxTokens,
      };
    });

    lines.push(...generateBarChart(chartData));
    lines.push("```");
    lines.push("");
  }

  // Summary Table with Savings (using dashboard aggregation)
  lines.push("## Summary by Strategy");
  lines.push("");
  lines.push("*Averaged across all models and task types*");
  lines.push("");
  lines.push("| Strategy | Tools | Avg Tokens | vs Baseline | Success |");
  lines.push("|----------|-------|------------|-------------|---------|");

  for (const agg of dashboardAgg) {
    const savingsKey = `${agg.strategy}|${agg.toolCount}`;
    const savingsPercent = savings.get(savingsKey);
    // Display passthrough as "baseline" in the strategy column
    const strategyDisplay =
      agg.strategy === "passthrough" ? "baseline (passthrough)" : agg.strategy;
    let savingsStr = "-";
    if (savingsPercent !== undefined) {
      if (savingsPercent > 0) {
        savingsStr = `↓ ${savingsPercent}% fewer`;
      } else if (savingsPercent < 0) {
        savingsStr = `↑ ${Math.abs(savingsPercent)}% more`;
      } else {
        savingsStr = "same";
      }
    } else if (agg.strategy === "passthrough") {
      savingsStr = "—";
    }
    lines.push(
      `| ${strategyDisplay} | ${agg.toolCount} | ${formatNumber(agg.avgTotalTokens)} | ${savingsStr} | ${agg.successRate}% |`,
    );
  }
  lines.push("");

  // Model Comparison
  lines.push("## Results by Model");
  lines.push("");

  const models = [...new Set(report.aggregated.map((a) => a.model))];
  for (const model of models) {
    const modelResults = report.aggregated.filter((a) => a.model === model);
    const modelName = model.split("/")[1] || model;

    lines.push(`### ${modelName}`);
    lines.push("");
    lines.push(
      "| Strategy | Tools | Input Tokens | Output Tokens | Total | Messages | Duration | Success |",
    );
    lines.push(
      "|----------|-------|--------------|---------------|-------|----------|----------|---------|",
    );

    for (const agg of modelResults) {
      lines.push(
        `| ${agg.strategy} | ${agg.toolCount} | ${formatNumber(agg.avgInputTokens)} | ${formatNumber(agg.avgOutputTokens)} | ${formatNumber(agg.avgTotalTokens)} | ${agg.avgMessageCount} | ${formatNumber(agg.avgDurationMs)}ms | ${agg.successRate}% |`,
      );
    }
    lines.push("");
  }

  // Key Insights (using dashboard aggregation for consistency with Summary table)
  lines.push("## Key Insights");
  lines.push("");

  // Calculate insights using dashboard aggregation (averaged across all models)
  const passthroughAt100 = dashboardAgg.find(
    (a) => a.strategy === "passthrough" && a.toolCount === 100,
  );
  const smartAt100 = dashboardAgg.find(
    (a) => a.strategy === "smart_tool_selection" && a.toolCount === 100,
  );
  if (passthroughAt100 && smartAt100) {
    const savings = Math.round(
      ((passthroughAt100.avgTotalTokens - smartAt100.avgTotalTokens) /
        passthroughAt100.avgTotalTokens) *
        100,
    );
    if (savings > 0) {
      lines.push(
        `- **Smart Tool Selection** saves ~${savings}% tokens compared to Passthrough at 100 tools`,
      );
    }
  }

  // Find best strategy per tool count (using dashboard aggregation for consistency)
  for (const tc of toolCounts) {
    const forToolCount = dashboardAgg.filter((a) => a.toolCount === tc);
    if (forToolCount.length > 0) {
      const best = forToolCount.reduce((a, b) =>
        a.avgTotalTokens < b.avgTotalTokens ? a : b,
      );
      // Display passthrough as "baseline"
      const strategyName =
        best.strategy === "passthrough" ? "baseline" : best.strategy;
      lines.push(
        `- At ${tc} tools, **${strategyName}** uses fewest tokens (${formatNumber(best.avgTotalTokens)} avg)`,
      );
    }
  }
  lines.push("");

  // Detailed Results
  lines.push("## Detailed Results");
  lines.push("");
  lines.push("<details>");
  lines.push("<summary>Click to expand individual scenario results</summary>");
  lines.push("");
  lines.push(
    "| Scenario | Success | Input | Output | Total | Messages | Duration |",
  );
  lines.push(
    "|----------|---------|-------|--------|-------|----------|----------|",
  );

  for (const result of report.results) {
    const status = result.success ? "✓" : "✗";
    lines.push(
      `| ${result.scenario.name} | ${status} | ${formatNumber(result.inputTokens)} | ${formatNumber(result.outputTokens)} | ${formatNumber(result.totalTokens)} | ${result.messageCount} | ${formatNumber(result.durationMs)}ms |`,
    );
  }
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // Errors (if any)
  const errors = report.results.filter((r) => r.error);
  if (errors.length > 0) {
    lines.push("## Errors");
    lines.push("");
    for (const result of errors) {
      lines.push(`- **${result.scenario.name}**: ${result.error}`);
    }
    lines.push("");
  }

  // Footer
  lines.push("---");
  lines.push("");
  lines.push("*Generated by MCP Gateway Benchmark Suite*");

  return lines.join("\n");
}

/**
 * Save the benchmark report to a markdown file
 */
export async function saveReport(
  results: BenchmarkResult[],
  totalDurationMs: number,
): Promise<string> {
  const timestamp = new Date();
  const aggregated = aggregateResults(results);

  const report: BenchmarkReport = {
    timestamp,
    results,
    aggregated,
    totalDurationMs,
  };

  const markdown = generateMarkdown(report);

  // Create results directory
  const resultsDir = join(import.meta.dir, "results");
  await mkdir(resultsDir, { recursive: true });

  // Generate filename with timestamp
  const filename = `${timestamp.toISOString().replace(/[:.]/g, "-")}.md`;
  const filepath = join(resultsDir, filename);

  // Write the file
  await writeFile(filepath, markdown, "utf-8");

  return filepath;
}

/**
 * Print a summary to console with ASCII dashboard
 */
export function printSummary(results: BenchmarkResult[]): void {
  // Use dashboard aggregation (across all models/tasks)
  const aggregated = aggregateForDashboard(results);
  const savings = calculateSavingsVsPassthrough(aggregated);

  console.log("\n" + "=".repeat(60));
  console.log("BENCHMARK SUMMARY");
  console.log("=".repeat(60) + "\n");

  // Get unique tool counts
  const toolCounts = [...new Set(aggregated.map((a) => a.toolCount))].sort(
    (a, b) => a - b,
  );

  // Print dashboard for each tool count
  for (const tc of toolCounts) {
    const resultsForTc = aggregated.filter((a) => a.toolCount === tc);
    if (resultsForTc.length === 0) continue;

    const maxTokens = Math.max(...resultsForTc.map((r) => r.avgTotalTokens));

    console.log(`📊 ${tc} Tools:`);

    for (const r of resultsForTc) {
      const barLength = Math.round((r.avgTotalTokens / maxTokens) * 30);
      const bar = "█".repeat(Math.max(1, barLength));
      const savingsKey = `${r.strategy}|${tc}`;
      const savingsPercent = savings.get(savingsKey);
      let savingsStr = "";
      if (savingsPercent !== undefined) {
        if (savingsPercent > 0) {
          savingsStr = ` (↓${savingsPercent}%)`;
        } else if (savingsPercent < 0) {
          savingsStr = ` (↑${Math.abs(savingsPercent)}%)`;
        }
      }
      // Display passthrough as "baseline"
      const strategyName =
        r.strategy === "passthrough" ? "baseline" : r.strategy;
      const label = strategyName.padEnd(22);
      console.log(
        `  ${label} ${bar} ${formatNumber(r.avgTotalTokens)}${savingsStr}`,
      );
    }
    console.log("");
  }

  // Table summary
  console.log(
    "Strategy               | Tools | Avg Tokens | vs Baseline | Success",
  );
  console.log(
    "-----------------------|-------|------------|-------------|--------",
  );

  for (const agg of aggregated) {
    // Display passthrough as "baseline"
    const strategyName =
      agg.strategy === "passthrough" ? "baseline" : agg.strategy;
    const strategy = strategyName.padEnd(22);
    const tools = String(agg.toolCount).padStart(5);
    const tokens = formatNumber(agg.avgTotalTokens).padStart(10);
    const savingsKey = `${agg.strategy}|${agg.toolCount}`;
    const savingsPercent = savings.get(savingsKey);
    let savingsStr = "—";
    if (savingsPercent !== undefined) {
      if (savingsPercent > 0) {
        savingsStr = `↓${savingsPercent}%`;
      } else if (savingsPercent < 0) {
        savingsStr = `↑${Math.abs(savingsPercent)}%`;
      } else {
        savingsStr = "same";
      }
    }
    const savingsCol = savingsStr.padStart(11);
    const success = `${agg.successRate}%`.padStart(7);
    console.log(
      `${strategy} | ${tools} | ${tokens} | ${savingsCol} | ${success}`,
    );
  }

  console.log("");
}
