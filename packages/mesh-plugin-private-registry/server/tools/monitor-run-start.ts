import type {
  ServerPluginToolContext,
  ServerPluginToolDefinition,
} from "@decocms/bindings/server-plugin";
import { WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import {
  generateText,
  jsonSchema,
  stepCountIs,
  tool,
  type JSONSchema7,
  type JSONValue,
  type ToolSet,
} from "ai";
import { z } from "zod";
import {
  MONITOR_AGENT_DEFAULT_SYSTEM_PROMPT,
  PLUGIN_ID,
  PUBLISH_REQUEST_TARGET_PREFIX,
} from "../../shared";
import type {
  MonitorResultStatus,
  MonitorRunConfigSnapshot,
  MonitorToolResult,
  PublishRequestEntity,
  PrivateRegistryItemEntity,
} from "../storage";
import {
  parseMonitorConfig,
  RegistryMonitorRunStartInputSchema,
  RegistryMonitorRunStartOutputSchema,
  type RegistryMonitorConfig,
} from "./monitor-schemas";
import { getPluginStorage } from "./utils";

type MCPTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    [key: string]: unknown;
  };
};

type MCPClientLike = {
  listTools?: () => Promise<{ tools?: MCPTool[] }>;
  callTool: (args: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<{
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
  }>;
  close?: () => Promise<void>;
};

type MonitorToolContext = ServerPluginToolContext & {
  organization: { id: string };
  storage: {
    connections: {
      create: (data: Record<string, unknown>) => Promise<{ id: string }>;
      findById: (
        id: string,
        organizationId?: string,
      ) => Promise<{ id: string } | null>;
    };
  };
  user?: { id?: string };
};

const runningControllers = new Map<string, AbortController>();
const LOG_PREFIX = "[MONITOR-AGENT]";
type MonitorLanguageModel = Parameters<typeof generateText>[0]["model"];
const MONITOR_AGENT_SYSTEM_PROMPT = MONITOR_AGENT_DEFAULT_SYSTEM_PROMPT;
const TOOL_NOT_CALLED_OUTPUT = "health_check: not called";

export function cancelMonitorRun(runId: string): boolean {
  const controller = runningControllers.get(runId);
  if (!controller) return false;
  controller.abort();
  runningControllers.delete(runId);
  return true;
}

function logWarn(...msgParts: unknown[]): void {
  console.warn(LOG_PREFIX, ...msgParts);
}

function logError(...msgParts: unknown[]): void {
  console.error(LOG_PREFIX, ...msgParts);
}

function resolveContext(ctx: ServerPluginToolContext): MonitorToolContext {
  if (!ctx.organization) {
    throw new Error("Organization context required");
  }
  return ctx as unknown as MonitorToolContext;
}

function resolveUserId(ctx: MonitorToolContext): string {
  const userId = ctx.user?.id ?? ctx.auth.user?.id;
  if (!userId) {
    throw new Error(
      "Authenticated user required to create monitor connections",
    );
  }
  return userId;
}

function detectConnectionType(item: PrivateRegistryItemEntity): "HTTP" | "SSE" {
  const remoteType = item.server.remotes?.[0]?.type?.toLowerCase();
  return remoteType === "sse" ? "SSE" : "HTTP";
}

function getRemoteUrl(item: PrivateRegistryItemEntity): string | null {
  const url = item.server.remotes?.find((r) => r.url)?.url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

function isAuthError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);
  return (
    message.includes("401") ||
    message.includes("unauthorized") ||
    message.includes("oauth") ||
    message.includes("authentication")
  );
}

function stringifyOutput(value: unknown): string | null {
  try {
    return JSON.stringify(value).slice(0, 800);
  } catch {
    return null;
  }
}

function buildNotCalledToolResult(toolName: string): MonitorToolResult {
  return {
    toolName,
    success: true,
    durationMs: 0,
    error: null,
    outputPreview: TOOL_NOT_CALLED_OUTPUT,
  };
}

function mergeWithDiscoveredTools(args: {
  discoveredTools: MCPTool[];
  executedResults: MonitorToolResult[];
}): MonitorToolResult[] {
  const executedByName = new Map(
    args.executedResults.map((result) => [result.toolName, result] as const),
  );
  const discoveredNames = new Set(
    args.discoveredTools.map((tool) => tool.name),
  );
  const merged = args.discoveredTools.map(
    (tool) =>
      executedByName.get(tool.name) ?? buildNotCalledToolResult(tool.name),
  );
  const extraResults = args.executedResults.filter(
    (result) => !discoveredNames.has(result.toolName),
  );
  return [...merged, ...extraResults];
}

function upsertToolResult(
  toolResults: MonitorToolResult[],
  nextResult: MonitorToolResult,
): void {
  const index = toolResults.findIndex(
    (result) => result.toolName === nextResult.toolName,
  );
  if (index >= 0) {
    toolResults[index] = nextResult;
    return;
  }
  toolResults.push(nextResult);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveAgentTimeoutMs(config: RegistryMonitorConfig): number {
  const steps = config.maxAgentSteps ?? 15;
  const estimatedBySteps = config.perToolTimeoutMs * steps + 15_000;
  // Agentic runs include multiple LLM/tool cycles, so keep a higher bound than per-MCP timeout.
  return Math.max(config.perMcpTimeoutMs, estimatedBySteps);
}

async function publishMonitorEvent(args: {
  ctx: MonitorToolContext;
  type: string;
  subject: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  const selfConnectionId = WellKnownOrgMCPId.SELF(args.ctx.organization.id);
  const proxy = await args.ctx.createMCPProxy(selfConnectionId);
  try {
    await proxy.callTool({
      name: "EVENT_PUBLISH",
      arguments: {
        type: args.type,
        subject: args.subject,
        data: args.data,
      },
    });
  } catch (error) {
    logWarn(
      `Failed to publish event ${args.type}:`,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await proxy.close?.().catch(() => {});
  }
}

function extractTextParts(
  content?: Array<{ type?: string; text?: string }>,
): string {
  return (
    content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim() ?? ""
  );
}

function isInputValidationErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("input validation error") ||
    lower.includes("invalid arguments for tool") ||
    lower.includes("expected string, received undefined") ||
    lower.includes("invalid option")
  );
}

function classifyToolErrorMessage(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes("invalidsharingrequest") ||
    lower.includes("no há uma conta do google associada") ||
    lower.includes("notificar pessoas") ||
    lower.includes("no google account associated")
  ) {
    return `USER_CONTEXT_REQUIRED: ${message}\nHint: Configure a valid Google account email in Monitor Configuration > Contexto extra para testes (prompt).`;
  }
  if (isInputValidationErrorMessage(message)) {
    return `AGENT_INPUT_ERROR: ${message}`;
  }
  if (
    message.includes(
      "Structured content does not match the tool's output schema",
    )
  ) {
    return `MCP_OUTPUT_SCHEMA_ERROR: ${message}`;
  }
  if (message.toLowerCase().includes("drive api error")) {
    return `MCP_RUNTIME_ERROR: ${message}`;
  }
  return message;
}

function isAgentInputError(error: string | null | undefined): boolean {
  return (error ?? "").startsWith("AGENT_INPUT_ERROR:");
}

function collapseToolResultsPreferSuccess(
  toolResults: MonitorToolResult[],
): MonitorToolResult[] {
  const byToolName = new Map<string, MonitorToolResult[]>();
  for (const result of toolResults) {
    const current = byToolName.get(result.toolName) ?? [];
    current.push(result);
    byToolName.set(result.toolName, current);
  }
  return Array.from(byToolName.entries()).map(([, results]) => {
    const latest = results.at(-1);
    if (!latest) {
      return {
        toolName: "unknown",
        success: false,
        durationMs: 0,
        error: "Missing tool result",
      } satisfies MonitorToolResult;
    }
    const latestSuccess = [...results]
      .reverse()
      .find((result) => result.success);
    return latestSuccess ?? latest;
  });
}

function parseModelResponse(payload: {
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
}): Record<string, unknown> {
  if (
    payload.structuredContent &&
    typeof payload.structuredContent === "object"
  ) {
    return payload.structuredContent as Record<string, unknown>;
  }
  const text = extractTextParts(payload.content);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringifyForPrompt(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function normalizeToolResultOutput(
  output: unknown,
  fallbackResult: unknown,
  isError: boolean,
): unknown {
  if (output && typeof output === "object") {
    return output;
  }
  if (isError) {
    return {
      type: "error-text",
      value: stringifyForPrompt(fallbackResult) || "Tool execution failed",
    };
  }
  if (typeof fallbackResult === "string") {
    return { type: "text", value: fallbackResult };
  }
  return { type: "json", value: (fallbackResult ?? {}) as JSONValue };
}

function normalizePromptMessageForBinding(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const record = message as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : "";

  if (role === "assistant" && Array.isArray(record.content)) {
    return {
      ...record,
      content: record.content.map((part) => {
        if (!part || typeof part !== "object") return part;
        const p = part as Record<string, unknown>;
        if (p.type === "tool-call") {
          return {
            ...p,
            input: stringifyForPrompt(p.input),
          };
        }
        if (p.type === "tool-result") {
          const result = p.result;
          return {
            ...p,
            output: normalizeToolResultOutput(
              p.output,
              result,
              p.isError === true,
            ),
            result: result ?? null,
          };
        }
        return p;
      }),
    };
  }

  if (role === "tool" && Array.isArray(record.content)) {
    return {
      ...record,
      content: record.content.map((part) => {
        if (!part || typeof part !== "object") return part;
        const p = part as Record<string, unknown>;
        const result = p.result;
        return {
          ...p,
          type: "tool-result",
          output: normalizeToolResultOutput(
            p.output,
            result,
            p.isError === true,
          ),
          result: result ?? null,
        };
      }),
    };
  }

  return record;
}

function convertCallOptionsForBinding(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const { abortSignal: _abortSignal, ...rest } = options;
  const prompt = Array.isArray(rest.prompt)
    ? rest.prompt.map((message) => normalizePromptMessageForBinding(message))
    : rest.prompt;
  return {
    ...rest,
    prompt,
  };
}

function createMonitorLanguageModel(args: {
  llmProxy: MCPClientLike;
  modelId: string;
}): MonitorLanguageModel {
  return {
    specificationVersion: "v2",
    provider: "mesh-monitor-llm-binding",
    modelId: args.modelId,
    supportedUrls: Promise.resolve({}),
    doGenerate: async (options: Record<string, unknown>) => {
      const callOptions = convertCallOptionsForBinding(options);
      const llmResult = await args.llmProxy.callTool({
        name: "LLM_DO_GENERATE",
        arguments: {
          modelId: args.modelId,
          callOptions,
        },
      });
      if (llmResult.isError) {
        throw new Error(
          extractTextParts(llmResult.content) || "LLM_DO_GENERATE failed",
        );
      }
      const parsed = parseModelResponse(llmResult);
      const response = parsed as Record<string, unknown>;
      return {
        content: Array.isArray(response.content)
          ? (response.content as never[])
          : [],
        finishReason:
          typeof response.finishReason === "string"
            ? (response.finishReason as
                | "stop"
                | "length"
                | "content-filter"
                | "tool-calls"
                | "error"
                | "other"
                | "unknown")
            : "other",
        usage:
          response.usage && typeof response.usage === "object"
            ? (response.usage as {
                inputTokens?: number;
                outputTokens?: number;
                totalTokens?: number;
                reasoningTokens?: number;
              })
            : {},
        warnings: Array.isArray(response.warnings)
          ? (response.warnings as never[])
          : [],
        providerMetadata:
          response.providerMetadata &&
          typeof response.providerMetadata === "object"
            ? response.providerMetadata
            : undefined,
        request:
          response.request && typeof response.request === "object"
            ? (response.request as { body?: unknown })
            : undefined,
        response:
          response.response && typeof response.response === "object"
            ? (response.response as {
                id?: string;
                timestamp?: Date | string;
                modelId?: string;
                headers?: Record<string, string>;
                body?: unknown;
              })
            : undefined,
      };
    },
    doStream: async () => {
      throw new Error("Monitor full_agent does not use streaming.");
    },
  } as unknown as MonitorLanguageModel;
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

function mcpToolsToAISDK(args: {
  proxy: MCPClientLike;
  tools: MCPTool[];
  perToolTimeoutMs: number;
  signal: AbortSignal;
  executions: MonitorToolResult[];
  onToolUpdate?: (toolResults: MonitorToolResult[]) => Promise<void> | void;
}): ToolSet {
  const entries = args.tools.map((mcpTool) => {
    const schema =
      mcpTool.inputSchema && typeof mcpTool.inputSchema === "object"
        ? (mcpTool.inputSchema as JSONSchema7)
        : ({
            type: "object",
            additionalProperties: true,
          } as JSONSchema7);
    return [
      mcpTool.name,
      tool<Record<string, unknown>, unknown>({
        description: mcpTool.description,
        inputSchema: jsonSchema(schema),
        execute: async (input) => {
          if (args.signal.aborted) {
            return {
              isError: true,
              content: [{ type: "text", text: "Run cancelled" }],
            };
          }
          const toolInput = normalizeToolInput(input);
          const callStartedAt = Date.now();
          try {
            let callResult = await withTimeout(
              args.proxy.callTool({
                name: mcpTool.name,
                arguments: toolInput,
              }),
              args.perToolTimeoutMs,
              `tool ${mcpTool.name}`,
            );
            let errorText = callResult.isError
              ? extractTextParts(callResult.content) || "Tool returned error"
              : null;
            if (
              callResult.isError &&
              errorText &&
              isInputValidationErrorMessage(errorText)
            ) {
              // One immediate retry gives the agent another chance to continue the loop
              // after transient validation mistakes.
              callResult = await withTimeout(
                args.proxy.callTool({
                  name: mcpTool.name,
                  arguments: toolInput,
                }),
                args.perToolTimeoutMs,
                `tool ${mcpTool.name} retry`,
              );
              errorText = callResult.isError
                ? extractTextParts(callResult.content) || "Tool returned error"
                : null;
            }
            const success = !callResult.isError;
            args.executions.push({
              toolName: mcpTool.name,
              success,
              input: toolInput,
              durationMs: Date.now() - callStartedAt,
              outputPreview: stringifyOutput(
                callResult.structuredContent ?? callResult.content,
              ),
              error: success
                ? null
                : classifyToolErrorMessage(errorText ?? "Tool returned error"),
            });
            await args.onToolUpdate?.(
              collapseToolResultsPreferSuccess([...args.executions]),
            );
            return callResult;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            args.executions.push({
              toolName: mcpTool.name,
              success: false,
              input: toolInput,
              durationMs: Date.now() - callStartedAt,
              error: classifyToolErrorMessage(message),
            });
            await args.onToolUpdate?.(
              collapseToolResultsPreferSuccess([...args.executions]),
            );
            return {
              isError: true,
              content: [{ type: "text", text: message }],
            };
          }
        },
        toModelOutput: ({ output }) => {
          const typed = output as {
            isError?: boolean;
            content?: Array<{ type?: string; text?: string }>;
            structuredContent?: unknown;
          };
          if (typed.isError) {
            return {
              type: "error-text",
              value: extractTextParts(typed.content) || "Tool returned error",
            };
          }
          if (typed.structuredContent !== undefined) {
            return {
              type: "json",
              value: (typed.structuredContent ?? {}) as JSONValue,
            };
          }
          const textValue = (typed.content ?? [])
            .map((part) => {
              if (part.type === "text") return part.text ?? "";
              return JSON.stringify(part);
            })
            .join("\n");
          return { type: "text", value: textValue };
        },
      }),
    ] as const;
  });

  return Object.fromEntries(entries);
}

async function runAgentTest(args: {
  ctx: MonitorToolContext;
  monitorConfig: RegistryMonitorConfig;
  item: PrivateRegistryItemEntity;
  proxy: MCPClientLike;
  tools: MCPTool[];
  signal: AbortSignal;
  onProgress?: (toolResults: MonitorToolResult[]) => Promise<void> | void;
}): Promise<{
  toolResults: MonitorToolResult[];
  agentSummary: string | null;
  unexecutedTools: string[];
}> {
  if (!args.monitorConfig.llmConnectionId || !args.monitorConfig.llmModelId) {
    throw new Error("full_agent mode requires an LLM connection and model.");
  }

  const llmProxy = await args.ctx.createMCPProxy(
    args.monitorConfig.llmConnectionId,
  );
  const executions: MonitorToolResult[] = [];
  try {
    const model = createMonitorLanguageModel({
      llmProxy: llmProxy as MCPClientLike,
      modelId: args.monitorConfig.llmModelId,
    });
    const aiTools = mcpToolsToAISDK({
      proxy: args.proxy,
      tools: args.tools,
      perToolTimeoutMs: args.monitorConfig.perToolTimeoutMs,
      signal: args.signal,
      executions,
      onToolUpdate: args.onProgress,
    });
    const basePrompt = [
      `MCP ID: ${args.item.id}`,
      `MCP Title: ${args.item.title}`,
      `MCP Description: ${args.item.description ?? "n/a"}`,
      `Available tools (${args.tools.length}): ${args.tools.map((tool) => tool.name).join(", ")}`,
      `User test context: ${args.monitorConfig.agentContext?.trim() || "none provided"}`,
      "Execute the tests now.",
    ].join("\n");
    const summaryParts: string[] = [];
    const maxRecoveryPasses = 2;
    for (let pass = 0; pass <= maxRecoveryPasses; pass++) {
      const collapsedSoFar = collapseToolResultsPreferSuccess(executions);
      const recoverableFailures = collapsedSoFar.filter(
        (execution) => !execution.success && isAgentInputError(execution.error),
      );
      const retryPrompt =
        recoverableFailures.length > 0
          ? [
              basePrompt,
              "",
              `Recovery pass ${pass}/${maxRecoveryPasses}: retry only tools with AGENT_INPUT_ERROR and fix arguments using IDs/context from previous successful calls.`,
              `Tools with AGENT_INPUT_ERROR: ${recoverableFailures.map((item) => item.toolName).join(", ")}`,
            ].join("\n")
          : basePrompt;
      const result = await withTimeout(
        generateText({
          model,
          system: MONITOR_AGENT_SYSTEM_PROMPT,
          messages: [{ role: "user", content: retryPrompt }],
          tools: aiTools,
          toolChoice: "auto",
          stopWhen: stepCountIs(args.monitorConfig.maxAgentSteps ?? 15),
          temperature: 0,
          abortSignal: args.signal,
        }),
        resolveAgentTimeoutMs(args.monitorConfig),
        `agent run ${args.item.id} pass ${pass + 1}`,
      );
      const trimmedSummary = (result.text ?? "").trim();
      if (trimmedSummary.length > 0) {
        summaryParts.push(trimmedSummary);
      }
      const collapsedAfterPass = collapseToolResultsPreferSuccess(executions);
      const stillRecoverableFailures = collapsedAfterPass.filter(
        (execution) => !execution.success && isAgentInputError(execution.error),
      );
      if (stillRecoverableFailures.length === 0) {
        break;
      }
    }

    const collapsedExecutions = collapseToolResultsPreferSuccess(executions);
    const testedToolNames = new Set(
      collapsedExecutions.map((execution) => execution.toolName),
    );
    const unexecutedTools = args.tools
      .map((tool) => tool.name)
      .filter((toolName) => !testedToolNames.has(toolName));
    const summaryBase = summaryParts.join("\n\n").trim();
    const skippedSummary =
      unexecutedTools.length > 0
        ? `Not executed tools (${unexecutedTools.length}/${args.tools.length}): ${unexecutedTools.join(", ")}`
        : "";
    const summary = [summaryBase, skippedSummary]
      .filter((part) => part.length > 0)
      .join("\n\n");
    return {
      toolResults: collapsedExecutions,
      agentSummary: summary.length > 0 ? summary : null,
      unexecutedTools,
    };
  } finally {
    await llmProxy.close?.().catch(() => {});
  }
}

export async function ensureMonitorConnection(
  ctx: MonitorToolContext,
  item: PrivateRegistryItemEntity,
): Promise<string> {
  const storage = getPluginStorage();
  const organizationId = ctx.organization.id;

  const existing = await storage.monitorConnections.findByItemId(
    organizationId,
    item.id,
  );
  if (existing) {
    const found = await ctx.storage.connections.findById(
      existing.connection_id,
      organizationId,
    );
    if (found) {
      return existing.connection_id;
    }
  }

  const remoteUrl = getRemoteUrl(item);
  if (!remoteUrl) {
    throw new Error(`Registry item ${item.id} has no remote URL`);
  }

  const userId = resolveUserId(ctx);
  const connType = detectConnectionType(item);
  const created = await ctx.storage.connections.create({
    organization_id: organizationId,
    created_by: userId,
    title: `[MCP Tester] ${item.title}`,
    description: `Auto-created monitor connection for ${item.id}`,
    app_name: "private-registry-monitor",
    app_id: `${PLUGIN_ID}:monitor`,
    connection_type: connType,
    connection_url: remoteUrl,
    metadata: {
      monitorConnection: true,
      registryItemId: item.id,
      pluginId: PLUGIN_ID,
    },
  });

  await storage.monitorConnections.upsert({
    organization_id: organizationId,
    item_id: item.id,
    connection_id: created.id,
    auth_status: "none",
  });

  return created.id;
}

async function applyFailureAction(args: {
  organizationId: string;
  item: PrivateRegistryItemEntity;
  action: RegistryMonitorConfig["onFailure"];
}): Promise<string> {
  const storage = getPluginStorage();
  switch (args.action) {
    case "unlisted": {
      await storage.items.update(args.organizationId, args.item.id, {
        is_unlisted: true,
      });
      return "unlisted";
    }
    case "remove_public": {
      await storage.items.update(args.organizationId, args.item.id, {
        is_public: false,
      });
      return "removed_public";
    }
    case "remove_private":
    case "remove_all": {
      await storage.items.delete(args.organizationId, args.item.id);
      return args.action === "remove_all" ? "removed_all" : "removed_private";
    }
    default:
      return "none";
  }
}

async function testSingleItem(args: {
  ctx: MonitorToolContext;
  organizationId: string;
  item: PrivateRegistryItemEntity;
  monitorConfig: RegistryMonitorConfig;
  signal: AbortSignal;
  canApplyFailureAction: boolean;
  onProgress?: (partial: {
    status: MonitorResultStatus;
    connectionOk: boolean;
    toolsListed: boolean;
    toolResults: MonitorToolResult[];
    agentSummary: string | null;
    errorMessage: string | null;
    actionTaken: string;
    durationMs: number;
  }) => Promise<void> | void;
}): Promise<{
  status: MonitorResultStatus;
  connectionOk: boolean;
  toolsListed: boolean;
  toolResults: MonitorToolResult[];
  agentSummary: string | null;
  errorMessage: string | null;
  actionTaken: string;
  durationMs: number;
}> {
  const startedAt = Date.now();
  if (args.signal.aborted) {
    throw new Error("Run cancelled");
  }

  let status: MonitorResultStatus = "passed";
  let connectionOk = false;
  let toolsListed = false;
  let errorMessage: string | null = null;
  let actionTaken = "none";
  let agentSummary: string | null = null;
  const toolResults: MonitorToolResult[] = [];
  let proxy: MCPClientLike | null = null;
  const emitProgress = async () => {
    await args.onProgress?.({
      status,
      connectionOk,
      toolsListed,
      toolResults: [...toolResults],
      agentSummary,
      errorMessage,
      actionTaken,
      durationMs: Date.now() - startedAt,
    });
  };

  try {
    const connectionId = await ensureMonitorConnection(args.ctx, args.item);
    proxy = await args.ctx.createMCPProxy(connectionId);
    connectionOk = true;

    const list = await withTimeout(
      proxy.listTools ? proxy.listTools() : Promise.resolve({ tools: [] }),
      args.monitorConfig.perMcpTimeoutMs,
      `listTools ${args.item.id}`,
    );
    const tools = list.tools ?? [];
    toolsListed = true;
    if (args.monitorConfig.monitorMode !== "health_check") {
      toolResults.push(
        ...tools.map((tool) => buildNotCalledToolResult(tool.name)),
      );
      await emitProgress();
    }

    if (args.monitorConfig.monitorMode === "full_agent") {
      const agentRun = await runAgentTest({
        ctx: args.ctx,
        monitorConfig: args.monitorConfig,
        item: args.item,
        proxy,
        tools,
        signal: args.signal,
        onProgress: async (updatedTools) => {
          toolResults.length = 0;
          toolResults.push(
            ...mergeWithDiscoveredTools({
              discoveredTools: tools,
              executedResults: updatedTools,
            }),
          );
          status = updatedTools.some((result) => !result.success)
            ? "failed"
            : "passed";
          await emitProgress();
        },
      });
      toolResults.length = 0;
      toolResults.push(
        ...mergeWithDiscoveredTools({
          discoveredTools: tools,
          executedResults: agentRun.toolResults,
        }),
      );
      agentSummary = agentRun.agentSummary;
      if (agentRun.toolResults.some((result) => !result.success)) {
        status = "failed";
      }
      if (agentRun.unexecutedTools.length > 0) {
        status = "failed";
        if (!errorMessage) {
          errorMessage = `Agent skipped ${agentRun.unexecutedTools.length} tool(s): ${agentRun.unexecutedTools.join(", ")}`;
        }
      }
    } else if (args.monitorConfig.monitorMode !== "health_check") {
      for (let i = 0; i < tools.length; i++) {
        const tool = tools[i];
        if (!tool || args.signal.aborted) throw new Error("Run cancelled");

        const callStart = Date.now();
        try {
          const toolInput = {};
          const result = await withTimeout(
            proxy.callTool({
              name: tool.name,
              arguments: toolInput,
            }),
            args.monitorConfig.perToolTimeoutMs,
            `tool ${tool.name}`,
          );
          const success = !result.isError;
          const elapsed = Date.now() - callStart;
          upsertToolResult(toolResults, {
            toolName: tool.name,
            success,
            input: toolInput,
            durationMs: elapsed,
            outputPreview: stringifyOutput(
              result.structuredContent ?? result.content,
            ),
            error: success
              ? null
              : classifyToolErrorMessage(
                  result.content
                    ?.find((part) => part.type === "text")
                    ?.text?.slice(0, 300) ?? "Tool returned error",
                ),
          });
          await emitProgress();
        } catch (error) {
          const elapsed = Date.now() - callStart;
          const message =
            error instanceof Error ? error.message : String(error);
          upsertToolResult(toolResults, {
            toolName: tool.name,
            success: false,
            durationMs: elapsed,
            error: classifyToolErrorMessage(message),
          });
          await emitProgress();
        }
      }
      if (toolResults.some((t) => !t.success)) {
        status = "failed";
      }
    } else {
      for (const tool of tools) {
        toolResults.push(buildNotCalledToolResult(tool.name));
      }
    }

    if (
      args.canApplyFailureAction &&
      status === "failed" &&
      args.monitorConfig.onFailure !== "none"
    ) {
      actionTaken = await applyFailureAction({
        organizationId: args.organizationId,
        item: args.item,
        action: args.monitorConfig.onFailure,
      });
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    if (isAuthError(error)) {
      status = "needs_auth";
      await getPluginStorage().monitorConnections.updateAuthStatus(
        args.organizationId,
        args.item.id,
        "needs_auth",
      );
    } else {
      status = "error";
    }
  } finally {
    await proxy?.close?.().catch(() => {});
  }

  return {
    status,
    connectionOk,
    toolsListed,
    toolResults,
    agentSummary,
    errorMessage,
    actionTaken,
    durationMs: Date.now() - startedAt,
  };
}

async function runMonitorLoop(args: {
  ctx: MonitorToolContext;
  runId: string;
  organizationId: string;
  monitorConfig: RegistryMonitorConfig;
  signal: AbortSignal;
}): Promise<void> {
  const runStartedAt = Date.now();
  const storage = getPluginStorage();

  const allItems = await storage.items.list(args.organizationId, {
    includeUnlisted: true,
  });

  const items = allItems.items.filter((item) => {
    if (args.monitorConfig.testPublicOnly && !item.is_public) return false;
    if (args.monitorConfig.testPrivateOnly && item.is_public) return false;
    return true;
  });

  const requestTargets: PrivateRegistryItemEntity[] = args.monitorConfig
    .includePendingRequests
    ? (
        await storage.publishRequests.list(args.organizationId, {
          status: "pending",
          limit: 500,
        })
      ).items.map((request) => publishRequestToMonitorTarget(request))
    : [];

  const targets: Array<{
    item: PrivateRegistryItemEntity;
    source: "registry_item" | "publish_request";
  }> = [
    ...items.map((item) => ({ item, source: "registry_item" as const })),
    ...requestTargets.map((item) => ({
      item,
      source: "publish_request" as const,
    })),
  ];

  if (targets.length === 0) {
    await storage.monitorRuns.update(args.organizationId, args.runId, {
      total_items: 0,
      status: "completed",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    });
    await publishMonitorEvent({
      ctx: args.ctx,
      type: "registry.monitor.completed",
      subject: args.runId,
      data: {
        runId: args.runId,
        total: 0,
      },
    });
    return;
  }

  await storage.monitorRuns.update(args.organizationId, args.runId, {
    total_items: targets.length,
    status: "running",
    started_at: new Date().toISOString(),
  });

  let tested = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (let idx = 0; idx < targets.length; idx++) {
    const target = targets[idx];
    const item = target?.item;
    if (!item || args.signal.aborted) {
      await storage.monitorRuns.update(args.organizationId, args.runId, {
        status: "cancelled",
        current_item_id: null,
        finished_at: new Date().toISOString(),
      });
      return;
    }

    await storage.monitorRuns.update(args.organizationId, args.runId, {
      current_item_id: item.id,
    });

    let persistedResultId: string | null = null;
    const persistItemProgress = async (partial: {
      status: MonitorResultStatus;
      connectionOk: boolean;
      toolsListed: boolean;
      toolResults: MonitorToolResult[];
      agentSummary: string | null;
      errorMessage: string | null;
      actionTaken: string;
      durationMs: number;
    }) => {
      if (!persistedResultId) {
        const createdPartial = await storage.monitorResults.create({
          run_id: args.runId,
          organization_id: args.organizationId,
          item_id: item.id,
          item_title: item.title,
          status: partial.status,
          error_message: partial.errorMessage,
          connection_ok: partial.connectionOk,
          tools_listed: partial.toolsListed,
          tool_results: partial.toolResults,
          agent_summary: partial.agentSummary,
          duration_ms: partial.durationMs,
          action_taken: partial.actionTaken,
        });
        persistedResultId = createdPartial.id;
        return;
      }

      await storage.monitorResults.update(
        args.organizationId,
        persistedResultId,
        {
          status: partial.status,
          error_message: partial.errorMessage,
          connection_ok: partial.connectionOk,
          tools_listed: partial.toolsListed,
          tool_results: partial.toolResults,
          agent_summary: partial.agentSummary,
          duration_ms: partial.durationMs,
          action_taken: partial.actionTaken,
        },
      );
    };

    const result = await testSingleItem({
      ctx: args.ctx,
      organizationId: args.organizationId,
      item,
      monitorConfig: args.monitorConfig,
      signal: args.signal,
      canApplyFailureAction: target.source === "registry_item",
      onProgress: persistItemProgress,
    });

    await persistItemProgress({
      status: result.status,
      connectionOk: result.connectionOk,
      toolsListed: result.toolsListed,
      toolResults: result.toolResults,
      agentSummary: result.agentSummary,
      errorMessage: result.errorMessage,
      actionTaken: result.actionTaken,
      durationMs: result.durationMs,
    });

    tested += 1;
    if (result.status === "passed") passed += 1;
    else if (result.status === "failed" || result.status === "error")
      failed += 1;
    else skipped += 1;

    await storage.monitorRuns.update(args.organizationId, args.runId, {
      tested_items: tested,
      passed_items: passed,
      failed_items: failed,
      skipped_items: skipped,
    });

    if (result.status === "failed" || result.status === "error") {
      await publishMonitorEvent({
        ctx: args.ctx,
        type: "registry.monitor.item_failed",
        subject: item.id,
        data: {
          runId: args.runId,
          itemId: item.id,
          itemTitle: item.title,
          status: result.status,
          errorMessage: result.errorMessage,
          actionTaken: result.actionTaken,
        },
      });
    }
  }

  const totalElapsed = Date.now() - runStartedAt;
  await storage.monitorRuns.update(args.organizationId, args.runId, {
    status: "completed",
    current_item_id: null,
    finished_at: new Date().toISOString(),
  });

  await publishMonitorEvent({
    ctx: args.ctx,
    type: "registry.monitor.completed",
    subject: args.runId,
    data: {
      runId: args.runId,
      total: tested,
      passed,
      failed,
      skipped,
      durationMs: totalElapsed,
    },
  });
}

function publishRequestToMonitorTarget(
  request: PublishRequestEntity,
): PrivateRegistryItemEntity {
  return {
    id: `${PUBLISH_REQUEST_TARGET_PREFIX}${request.id}`,
    title: request.title,
    description: request.description,
    _meta: request._meta,
    server: request.server,
    is_public: false,
    is_unlisted: true,
    created_at: request.created_at,
    updated_at: request.updated_at,
  };
}

async function startMonitorRun(
  ctx: ServerPluginToolContext,
  config: RegistryMonitorConfig,
): Promise<{ run: { id: string } }> {
  const monitorCtx = resolveContext(ctx);
  await monitorCtx.access.check();

  const storage = getPluginStorage();
  const run = await storage.monitorRuns.create({
    organization_id: monitorCtx.organization.id,
    status: "pending",
    config_snapshot: config as MonitorRunConfigSnapshot,
    started_at: null,
  });

  const controller = new AbortController();
  runningControllers.set(run.id, controller);

  void runMonitorLoop({
    ctx: monitorCtx,
    runId: run.id,
    organizationId: monitorCtx.organization.id,
    monitorConfig: config,
    signal: controller.signal,
  })
    .catch(async (error) => {
      await storage.monitorRuns
        .update(monitorCtx.organization.id, run.id, {
          status: "failed",
          current_item_id: null,
          finished_at: new Date().toISOString(),
        })
        .catch(() => {});
      await publishMonitorEvent({
        ctx: monitorCtx,
        type: "registry.monitor.failed",
        subject: run.id,
        data: {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      logError(`Run ${run.id} failed with uncaught error:`, error);
    })
    .finally(() => {
      runningControllers.delete(run.id);
    });

  return { run: { id: run.id } };
}

export const REGISTRY_MONITOR_RUN_START: ServerPluginToolDefinition = {
  name: "REGISTRY_MONITOR_RUN_START",
  description:
    "Start an MCP registry monitor run with an isolated set of monitor connections.",
  inputSchema: RegistryMonitorRunStartInputSchema,
  outputSchema: RegistryMonitorRunStartOutputSchema,
  handler: async (input, ctx) => {
    const typedInput = input as z.infer<
      typeof RegistryMonitorRunStartInputSchema
    >;
    const monitorConfig = parseMonitorConfig(typedInput.config ?? {});
    const { run } = await startMonitorRun(ctx, monitorConfig);
    const storage = getPluginStorage();
    const fullRun = await storage.monitorRuns.findById(
      resolveContext(ctx).organization.id,
      run.id,
    );
    if (!fullRun) {
      throw new Error(`Failed to load monitor run ${run.id}`);
    }
    return { run: fullRun };
  },
};
