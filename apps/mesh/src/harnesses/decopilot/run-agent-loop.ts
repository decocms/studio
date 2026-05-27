/**
 * runAgentLoop — shared core for the decopilot harness.
 *
 * Owns: system-prompt assembly, tool assembly, streamText invocation,
 * prepareStep, error capture, OTel span for the loop itself.
 *
 * Does NOT own: HTTP plumbing, persistence, title generation, run-
 * registry registration (parent-wrapper concerns), nor target-agent
 * validation / MCP-client creation (subagent-wrapper concerns).
 */

import type { MeshContext, OrganizationScope } from "@/core/mesh-context";
import type { MeshProvider } from "@/ai-providers/types";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Span, Tracer } from "@opentelemetry/api";
import type {
  ModelMessage,
  StreamTextResult,
  ToolSet,
  StreamTextOnStepFinishCallback,
} from "ai";
import type { ModelsConfig } from "../../api/routes/decopilot/types";
import type { ToolApprovalLevel } from "../../api/routes/decopilot/helpers";
import type { UsageStats } from "@decocms/mesh-sdk";

export interface RunAgentLoopOptions {
  ctx: MeshContext;
  organization: OrganizationScope;
  virtualMcp: { id: string; instructions?: string };
  mcpClient: Client;
  provider: MeshProvider;
  models: ModelsConfig;
  messages: ModelMessage[];
  systemAgentInstructions?: string;
  kind: "agent" | "subagent";
  stepLimit?: number;
  toolApprovalLevel?: ToolApprovalLevel;
  planMode?: boolean;
  temperature?: number;
  abortSignal: AbortSignal;
  tracer?: Tracer;
  onStepFinish?: StreamTextOnStepFinishCallback<ToolSet>;
  onUsageAggregated?: (usage: UsageStats) => void;

  // ── Stage 1 shim — deleted in Stage 2 once runAgentLoop owns
  //    tool + system assembly itself.
  __tools?: ToolSet;
  __system?: unknown;
  __prepareStep?: unknown;
}

export interface RunAgentLoopHandle {
  result: StreamTextResult<ToolSet, never>;
  error: Promise<string | undefined>;
  span: Span;
}

export async function runAgentLoop(
  opts: RunAgentLoopOptions,
): Promise<RunAgentLoopHandle> {
  if (opts.kind === "subagent") {
    throw new Error(
      "runAgentLoop: kind 'subagent' not yet implemented in Stage 1",
    );
  }
  // Stage 1: parent body is filled in in Task 1.2.
  throw new Error("runAgentLoop: 'agent' kind body not yet wired up");
}
