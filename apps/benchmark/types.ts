/**
 * Benchmark Suite Type Definitions
 *
 * Shared types for the MCP Gateway benchmark system.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Gateway tool selection strategy options
 */
export type VirtualMCPtoolSelectionStrategy =
  | "passthrough"
  | "smart_tool_selection";

/**
 * Task definition for a benchmark scenario
 */
export interface BenchmarkTask {
  /** Natural language prompt describing what to accomplish */
  prompt: string;
  /** The expected final tool call to complete the task */
  expectedToolCall: {
    tool: string;
    args: Record<string, unknown>;
  };
  /**
   * Whether this is a chained/multi-step task requiring intermediate tool calls.
   * Chained tasks are more complex - the agent needs to call other tools first
   * to gather information before making the final expected tool call.
   */
  isChained?: boolean;
}

/**
 * Benchmark scenario configuration
 */
export interface BenchmarkScenario {
  /** Unique name for this scenario */
  name: string;
  /** OpenRouter model ID (e.g., "openai/gpt-4o") */
  model: string;
  /** Number of tools to generate */
  toolCount: number;
  /** Task to accomplish */
  task: BenchmarkTask;
  /** Gateway strategy to use */
  strategy: VirtualMCPtoolSelectionStrategy;
}

/**
 * Result from a single benchmark run
 */
export interface BenchmarkResult {
  /** Scenario that was run */
  scenario: BenchmarkScenario;
  /** Whether the task was completed successfully */
  success: boolean;
  /** Number of messages exchanged */
  messageCount: number;
  /** Total input tokens used */
  inputTokens: number;
  /** Total output tokens used */
  outputTokens: number;
  /** Total tokens (input + output) */
  totalTokens: number;
  /** Time taken in milliseconds */
  durationMs: number;
  /** Error message if failed */
  error?: string;
  /** Tool that was actually called (if any) */
  calledTool?: string;
  /** Number of tools exposed by gateway */
  exposedToolCount: number;
}

/**
 * Aggregated results for reporting
 */
export interface AggregatedResult {
  strategy: VirtualMCPtoolSelectionStrategy;
  toolCount: number;
  model: string;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgTotalTokens: number;
  avgMessageCount: number;
  avgDurationMs: number;
  successRate: number;
  sampleCount: number;
}

/**
 * Full benchmark report
 */
export interface BenchmarkReport {
  /** When the benchmark was run */
  timestamp: Date;
  /** Individual results */
  results: BenchmarkResult[];
  /** Aggregated results by strategy/toolCount/model */
  aggregated: AggregatedResult[];
  /** Total duration in milliseconds */
  totalDurationMs: number;
}

/**
 * Configuration for the benchmark runner
 */
export interface BenchmarkConfig {
  /** Maximum messages per scenario before giving up */
  maxMessages: number;
  /** Port for the fake MCP server */
  fakeMcpPort: number;
  /** Port for the mesh server */
  meshPort: number;
  /** Whether to log verbose output */
  verbose: boolean;
}

/**
 * Tool with handler for the fake MCP server
 */
export interface ToolWithHandler {
  tool: Tool;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Mesh server interface for benchmark
 */
export interface MeshServerHandle {
  /** Base URL for the mesh server */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Create a connection to a fake MCP */
  createConnection: (mcpUrl: string) => Promise<string>;
  /** Create a gateway with the given strategy */
  createGateway: (
    connectionId: string,
    strategy: VirtualMCPtoolSelectionStrategy,
  ) => Promise<string>;
  /** Get gateway URL with optional mode query parameter */
  getGatewayUrl: (
    gatewayId: string,
    strategy?: VirtualMCPtoolSelectionStrategy,
  ) => string;
  /** Cleanup resources */
  cleanup: () => Promise<void>;
}

/**
 * Fake MCP server handle
 */
export interface FakeMcpHandle {
  /** URL of the fake MCP server */
  url: string;
  /** Close the server */
  close: () => void;
}

/**
 * LLM response with token usage
 */
export interface LLMResponse {
  /** Text content of the response */
  text: string;
  /** Tool calls made by the model */
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
  }>;
  /** Token usage */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Guide interface for chat simulation
 */
export interface Guide {
  /** Get initial prompt for the task */
  getInitialPrompt(task: BenchmarkTask): string;
  /** Get response after a failed attempt */
  getRetryPrompt(
    task: BenchmarkTask,
    attempt: number,
    lastResponse: string,
  ): string;
}
