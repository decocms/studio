/**
 * Benchmark Configuration
 *
 * Defines the scenarios to benchmark and default configuration.
 */

import type {
  BenchmarkConfig,
  BenchmarkScenario,
  VirtualMCPtoolSelectionStrategy,
} from "./types";

/**
 * Default benchmark configuration
 */
export const DEFAULT_CONFIG: BenchmarkConfig = {
  maxMessages: 4,
  fakeMcpPort: 0, // Let the system assign a port
  meshPort: 0, // Let the system assign a port
  verbose: true,
};

/**
 * Models to benchmark
 *
 * OpenRouter model IDs for the best tool-calling models from each provider
 * See: https://openrouter.ai/models
 *
 * Note: OpenAI/Azure has a 128 tool limit, so we use Claude for high tool counts
 */
const BENCHMARK_MODELS = [
  "anthropic/claude-sonnet-4.5", // Claude Sonnet 4.5 - supports many tools
  "openai/gpt-4o",
  "google/gemini-2.0-flash-001",
] as const;

/**
 * Default model for quick/high benchmarks (supports high tool counts)
 */
const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

/**
 * Tool counts to test
 */
const TOOL_COUNTS = [10, 50, 100, 300, 500] as const;

/**
 * Virtual MCP strategies to compare
 */
const STRATEGIES: VirtualMCPtoolSelectionStrategy[] = [
  "passthrough",
  // "smart_tool_selection", there's a bug in the smart tool selection strategy for now we are not using yet.
];

/**
 * Simple tasks - single tool call
 */
const SIMPLE_TASKS = [
  {
    prompt:
      "Send an email to john@example.com with subject 'Meeting Tomorrow' and body 'Let's meet at 10am.'",
    expectedToolCall: {
      tool: "send_email",
      args: {
        to: "john@example.com",
        subject: "Meeting Tomorrow",
        body: "Let's meet at 10am.",
      },
    },
  },
  {
    prompt:
      "Create a calendar event titled 'Team Standup' on 2025-01-15 at 9:00 AM.",
    expectedToolCall: {
      tool: "create_calendar_event",
      args: {
        title: "Team Standup",
        date: "2025-01-15",
        time: "9:00",
      },
    },
  },
  {
    prompt:
      "Search for files containing 'quarterly report' in the documents folder.",
    expectedToolCall: {
      tool: "search_files",
      args: {
        query: "quarterly report",
        folder: "documents",
      },
    },
  },
];

/**
 * Chained tasks - require multiple tool calls to complete
 *
 * These are more realistic scenarios where the agent needs to:
 * 1. Call intermediate tools to gather information
 * 2. Finally call the target tool with the gathered data
 *
 * The expectedToolCall is still the final target tool.
 * The task requires discovering information first.
 */
const CHAINED_TASKS = [
  {
    // Chain: get_user → list_tasks → send_email
    prompt:
      "Find the user 'alice', check what tasks she has pending, and send her an email summarizing her pending work at alice@company.com.",
    expectedToolCall: {
      tool: "send_email",
      args: {
        to: "alice@company.com",
        subject: "Your Pending Tasks",
        body: "Here is a summary of your pending tasks.",
      },
    },
    isChained: true,
  },
  {
    // Chain: search_files → read_file → send_email
    prompt:
      "Search for the quarterly report file, read it, and email the summary to manager@company.com with subject 'Q4 Report Summary'.",
    expectedToolCall: {
      tool: "send_email",
      args: {
        to: "manager@company.com",
        subject: "Q4 Report Summary",
        body: "Report summary content.",
      },
    },
    isChained: true,
  },
  {
    // Chain: query_database → get_metrics → send_notification
    prompt:
      "Query the database for active users count, get the daily metrics, and send a notification to user 'admin' with the statistics.",
    expectedToolCall: {
      tool: "send_notification",
      args: {
        user_id: "admin",
        title: "Daily Statistics",
        message: "Active users and metrics report.",
      },
    },
    isChained: true,
  },
];

/**
 * All tasks for benchmarking
 */
const BENCHMARK_TASKS = [...SIMPLE_TASKS, ...CHAINED_TASKS];

/**
 * Generate all benchmark scenarios
 *
 * Creates a scenario for each combination of:
 * - Model
 * - Tool count
 * - Strategy
 * - Task (mix of simple and chained)
 */
export function generateScenarios(): BenchmarkScenario[] {
  const scenarios: BenchmarkScenario[] = [];

  for (const model of BENCHMARK_MODELS) {
    for (const toolCount of TOOL_COUNTS) {
      for (const strategy of STRATEGIES) {
        for (const task of BENCHMARK_TASKS) {
          const modelName = model.split("/")[1] || model;
          const taskType =
            "isChained" in task && task.isChained ? "chained" : "simple";
          const taskTool = task.expectedToolCall.tool;
          scenarios.push({
            name: `${modelName}/${strategy}/${toolCount}tools/${taskType}/${taskTool}`,
            model,
            toolCount,
            task,
            strategy,
          });
        }
      }
    }
  }

  return scenarios;
}

/**
 * Models for quick benchmarks
 */
const QUICK_MODELS = ["openai/gpt-5.2", "anthropic/claude-sonnet-4.5"] as const;

/**
 * Generate a smaller set of scenarios for quick testing
 * Tests two models with all strategies at 10 and 128 tools
 */
export function generateQuickScenarios(): BenchmarkScenario[] {
  const scenarios: BenchmarkScenario[] = [];

  for (const model of QUICK_MODELS) {
    const modelName = model.split("/")[1] || model;

    for (const strategy of STRATEGIES) {
      for (const toolCount of [10, 128]) {
        // One simple task
        const simpleTask = SIMPLE_TASKS[0];
        scenarios.push({
          name: `${modelName}/${strategy}/${toolCount}tools/simple`,
          model,
          toolCount,
          task: simpleTask,
          strategy,
        });

        // One chained task
        const chainedTask = CHAINED_TASKS[0];
        scenarios.push({
          name: `${modelName}/${strategy}/${toolCount}tools/chained`,
          model,
          toolCount,
          task: chainedTask,
          strategy,
        });
      }
    }
  }

  return scenarios;
}

/**
 * Generate scenarios focused on high tool counts (300+)
 * This tests how strategies scale with many tools
 * Uses Claude which supports more tools than OpenAI (128 limit)
 */
export function generateHighToolCountScenarios(): BenchmarkScenario[] {
  const scenarios: BenchmarkScenario[] = [];

  const model = DEFAULT_MODEL;
  const modelName = model.split("/")[1] || model;
  const highToolCounts = [100, 300, 500];

  for (const strategy of STRATEGIES) {
    for (const toolCount of highToolCounts) {
      // One simple task
      const simpleTask = SIMPLE_TASKS[0];
      scenarios.push({
        name: `${modelName}/${strategy}/${toolCount}tools/simple`,
        model,
        toolCount,
        task: simpleTask,
        strategy,
      });

      // One chained task
      const chainedTask = CHAINED_TASKS[0];
      scenarios.push({
        name: `${modelName}/${strategy}/${toolCount}tools/chained`,
        model,
        toolCount,
        task: chainedTask,
        strategy,
      });
    }
  }

  return scenarios;
}
