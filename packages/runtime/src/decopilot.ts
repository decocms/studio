import type { UIMessage } from "ai";

// ============================================================================
// Agent Model Types
// ============================================================================

export interface AgentModelInfo {
  id: string;
  title: string;
  capabilities?: {
    vision?: boolean;
    text?: boolean;
    tools?: boolean;
    reasoning?: boolean;
  };
  provider?: string | null;
  limits?: { contextWindow?: number; maxOutputTokens?: number };
}

// ============================================================================
// Agent Binding Config (lives in StateSchema)
// ============================================================================

export interface AgentBindingConfig {
  __type: "@deco/agent";
  /** Virtual MCP connection ID (binding pointer) */
  value?: string;
  /** Agent ID — may be absent when state only stores a binding reference */
  id?: string;
  credentialId?: string;
  thinking?: AgentModelInfo;
  coding?: AgentModelInfo;
  fast?: AgentModelInfo;
  toolApprovalLevel?: "auto" | "readonly" | "plan";
  temperature?: number;
}

// ============================================================================
// STREAM() params — messages + optional overrides
// ============================================================================

export interface AgentStreamParams {
  messages: Omit<UIMessage, "id">[];
  credentialId?: string;
  thinking?: AgentModelInfo;
  coding?: AgentModelInfo;
  fast?: AgentModelInfo;
  toolApprovalLevel?: "auto" | "readonly" | "plan";
  temperature?: number;
  memory?: { windowSize: number; thread_id: string };
  thread_id?: string;
}

// ============================================================================
// Resolved agent client — what env.MY_AGENT becomes after binding resolution
// ============================================================================

export interface ResolvedAgentClient {
  STREAM: (
    params: AgentStreamParams,
    opts?: { signal?: AbortSignal },
  ) => Promise<AsyncIterable<UIMessage> & ReadableStream<UIMessage>>;
}

// ============================================================================
// SSE → UIMessageChunk parsing (mirrors DefaultChatTransport.processResponseStream)
// ============================================================================

async function parseResponseStream(
  body: ReadableStream<Uint8Array>,
): Promise<ReadableStream> {
  const { parseJsonEventStream, uiMessageChunkSchema } = await import("ai");
  return parseJsonEventStream({
    stream: body,
    schema: uiMessageChunkSchema,
  }).pipeThrough(
    new TransformStream({
      transform(result, controller) {
        if (!result.success) {
          throw result.error;
        }
        controller.enqueue(result.value);
      },
    }),
  );
}

// ============================================================================
// Core stream function (used by binding proxy and standalone client)
// ============================================================================

export async function streamAgent(
  streamUrl: string,
  token: string,
  config: AgentBindingConfig,
  params: AgentStreamParams,
  opts?: { signal?: AbortSignal },
) {
  const { readUIMessageStream } = await import("ai");

  const agentId = config.value ?? config.id;
  if (!agentId) {
    throw new Error("Agent binding has no id or value — cannot resolve agent");
  }

  const credentialId = params.credentialId ?? config.credentialId;
  const thinking = params.thinking ?? config.thinking;
  const hasModels = credentialId && thinking?.id;

  const request = {
    messages: params.messages,
    ...(hasModels
      ? {
          models: {
            credentialId,
            thinking,
            ...((params.coding ?? config.coding)
              ? { coding: params.coding ?? config.coding }
              : {}),
            ...((params.fast ?? config.fast)
              ? { fast: params.fast ?? config.fast }
              : {}),
          },
        }
      : {}),
    agent: { id: agentId },
    temperature: params.temperature ?? config.temperature,
    toolApprovalLevel: params.toolApprovalLevel ?? config.toolApprovalLevel,
    ...(params.memory ? { memory: params.memory } : {}),
    ...(params.thread_id ? { thread_id: params.thread_id } : {}),
  };

  const response = await fetch(streamUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-mesh-token": token,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(request),
    signal: opts?.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = `HTTP ${response.status}`;
    try {
      const body = JSON.parse(text);
      if (body?.error) message = body.error;
    } catch {
      if (text) message = text;
    }
    throw new Error(message);
  }

  if (!response.body) {
    throw new Error("Empty response body from decopilot stream");
  }

  const chunkStream = await parseResponseStream(response.body);
  return readUIMessageStream({ stream: chunkStream });
}

// ============================================================================
// Standalone client factory (for direct usage outside binding system)
// ============================================================================

export interface DecopilotClientOptions {
  baseUrl: string;
  orgSlug: string;
  token: string;
}

export function createDecopilotClient(options: DecopilotClientOptions) {
  const { baseUrl, orgSlug, token } = options;
  const streamUrl = `${baseUrl}/${orgSlug}/decopilot/runtime/stream`;

  return {
    stream(
      request: AgentStreamParams & { agent: { id: string } },
      opts?: { signal?: AbortSignal },
    ) {
      const config: AgentBindingConfig = {
        __type: "@deco/agent",
        id: request.agent.id,
        credentialId: request.credentialId ?? "",
        thinking: request.thinking ?? { id: "", title: "" },
        coding: request.coding,
        fast: request.fast,
        toolApprovalLevel: request.toolApprovalLevel,
        temperature: request.temperature,
      };
      return streamAgent(streamUrl, token, config, request, opts);
    },
  };
}
