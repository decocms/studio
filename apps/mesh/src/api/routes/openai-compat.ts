/**
 * OpenAI-Compatible API Routes
 *
 * Provides an OpenAI-compatible /v1/chat/completions endpoint for organization-scoped
 * LLM access. Supports full OpenAI spec including tools/function calling.
 *
 * Authentication: Bearer token (API key) with organization metadata
 * Model format: "model_id" or "credential_id:model_id"
 */

import {
  generateText,
  jsonSchema,
  streamText,
  tool,
  type JSONSchema7,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { StudioContext } from "../../core/studio-context";

// ============================================================================
// Types & Schemas
// ============================================================================

/**
 * OpenAI-compatible tool definition
 */
const OpenAIToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

/**
 * OpenAI-compatible tool call
 */
const OpenAIToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

/**
 * OpenAI-compatible message
 */
const OpenAIMessageSchema = z.discriminatedUnion("role", [
  // System message
  z.object({
    role: z.literal("system"),
    content: z.string(),
    name: z.string().optional(),
  }),
  // User message
  z.object({
    role: z.literal("user"),
    content: z.union([
      z.string(),
      z.array(
        z.union([
          z.object({ type: z.literal("text"), text: z.string() }),
          z.object({
            type: z.literal("image_url"),
            image_url: z.object({
              url: z.string(),
              detail: z.string().optional(),
            }),
          }),
        ]),
      ),
    ]),
    name: z.string().optional(),
  }),
  // Assistant message
  z.object({
    role: z.literal("assistant"),
    content: z.string().nullable().optional(),
    name: z.string().optional(),
    tool_calls: z.array(OpenAIToolCallSchema).optional(),
  }),
  // Tool result message
  z.object({
    role: z.literal("tool"),
    content: z.string(),
    tool_call_id: z.string(),
  }),
]);

type OpenAIMessage = z.infer<typeof OpenAIMessageSchema>;
type OpenAITool = z.infer<typeof OpenAIToolSchema>;

/**
 * OpenAI-compatible response format schemas
 */
const ResponseFormatTextSchema = z.object({
  type: z.literal("text"),
});

const ResponseFormatJsonObjectSchema = z.object({
  type: z.literal("json_object"),
});

const ResponseFormatJsonSchemaSchema = z.object({
  type: z.literal("json_schema"),
  json_schema: z.object({
    name: z.string(),
    description: z.string().optional(),
    schema: z.record(z.string(), z.unknown()),
    strict: z.boolean().optional(),
  }),
});

const ResponseFormatSchema = z.union([
  ResponseFormatTextSchema,
  ResponseFormatJsonObjectSchema,
  ResponseFormatJsonSchemaSchema,
]);

type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

/**
 * OpenAI-compatible chat completion request
 */
const ChatCompletionRequestSchema = z.object({
  model: z.string().describe("Format: 'model_id' or 'credential_id:model_id'"),
  messages: z.array(OpenAIMessageSchema),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z.array(OpenAIToolSchema).optional(),
  tool_choice: z
    .union([
      z.literal("auto"),
      z.literal("none"),
      z.literal("required"),
      z.object({
        type: z.literal("function"),
        function: z.object({ name: z.string() }),
      }),
    ])
    .optional(),
  response_format: ResponseFormatSchema.optional(),
  user: z.string().optional(),
});

type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create OpenAI-compatible error response
 */
function createErrorResponse(
  message: string,
  type: string = "invalid_request_error",
  param: string | null = null,
  code: string | null = null,
) {
  return {
    error: {
      message,
      type,
      param,
      code,
    },
  };
}

/**
 * Parse model string into optional credentialId and modelId.
 * Accepts two formats:
 *   - "credential_id:model_id" — explicit credential
 *   - "model_id"              — uses the org's default credential
 */
function parseModelString(model: string): {
  credentialId: string | null;
  modelId: string;
} | null {
  if (!model) return null;

  const colonIndex = model.indexOf(":");
  if (colonIndex === -1) {
    return { credentialId: null, modelId: model };
  }

  const credentialId = model.substring(0, colonIndex);
  const modelId = model.substring(colonIndex + 1);

  if (!credentialId || !modelId) {
    return null;
  }

  return { credentialId, modelId };
}

/**
 * Custom error for message conversion validation failures
 */
class MessageConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageConversionError";
  }
}

/**
 * Safely parse JSON with a descriptive error message
 */
function safeParseToolArguments(
  args: string,
  toolCallId: string,
  functionName: string,
): unknown {
  try {
    return JSON.parse(args);
  } catch {
    throw new MessageConversionError(
      `Invalid JSON in tool call arguments for function '${functionName}' (tool_call_id: ${toolCallId}): ${args}`,
    );
  }
}

/**
 * Convert OpenAI messages to AI SDK message format
 * Returns a format compatible with streamText/generateText
 * @throws {MessageConversionError} if tool call arguments contain invalid JSON
 */
function convertToAISDKMessages(messages: OpenAIMessage[]): ModelMessage[] {
  // Build a map of tool_call_id -> toolName from assistant messages
  // This is needed because OpenAI tool messages don't include the tool name
  const toolCallIdToName: Record<string, string> = {};
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCallIdToName[tc.id] = tc.function.name;
      }
    }
  }

  return messages.map((msg): ModelMessage => {
    switch (msg.role) {
      case "system":
        return { role: "system", content: msg.content };

      case "user":
        if (typeof msg.content === "string") {
          return { role: "user", content: msg.content };
        }
        // Handle multi-part content (text + images)
        return {
          role: "user",
          content: msg.content.map((part) => {
            if (part.type === "text") {
              return { type: "text" as const, text: part.text };
            }
            return { type: "image" as const, image: part.image_url.url };
          }),
        };

      case "assistant":
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // AI SDK v6 expects tool-call parts with 'input' (not 'args')
          return {
            role: "assistant",
            content: msg.tool_calls.map((tc) => ({
              type: "tool-call" as const,
              toolCallId: tc.id,
              toolName: tc.function.name,
              input: safeParseToolArguments(
                tc.function.arguments,
                tc.id,
                tc.function.name,
              ),
            })) as unknown as ModelMessage["content"],
          } as ModelMessage;
        }
        return { role: "assistant", content: msg.content ?? "" };

      case "tool":
        // AI SDK v6 expects tool-result parts with 'output' (not 'result')
        // Look up the tool name from the preceding assistant message's tool_calls
        const toolName = toolCallIdToName[msg.tool_call_id] ?? "unknown";
        // AI SDK v6 expects output as { type: 'text', value: string }
        return {
          role: "tool",
          content: [
            {
              type: "tool-result" as const,
              toolCallId: msg.tool_call_id,
              toolName,
              output: { type: "text", value: msg.content },
            },
          ],
        } as unknown as ModelMessage;
    }
  });
}

/**
 * Convert OpenAI tools to AI SDK ToolSet
 * These are "static" tools that just define the schema - no execute function
 * The model will generate tool calls that can be returned to the client
 */
function convertToAISDKTools(openaiTools: OpenAITool[]): ToolSet {
  const toolEntries = openaiTools.map((t) => {
    const schema = t.function.parameters
      ? jsonSchema(t.function.parameters as JSONSchema7)
      : jsonSchema({ type: "object", properties: {} } as JSONSchema7);

    // Create tool with schema - type assertion needed due to complex AI SDK types
    return [
      t.function.name,
      tool({
        description: t.function.description,
        inputSchema: schema as Parameters<typeof tool>[0]["inputSchema"],
      }),
    ];
  });

  return Object.fromEntries(toolEntries);
}

/**
 * Convert OpenAI response_format to AI SDK providerOptions
 * This passes through the response format to OpenAI-compatible providers
 */
function convertResponseFormat(
  responseFormat: ResponseFormat | undefined,
): Record<string, unknown> | undefined {
  if (!responseFormat) {
    return undefined;
  }

  // Pass through the OpenAI response_format to the provider
  // This works for OpenAI and OpenAI-compatible providers
  return {
    openai: {
      response_format: responseFormat,
    },
  };
}

/**
 * Generate a unique completion ID
 */
function generateCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").substring(0, 29)}`;
}

/**
 * Build common options for generateText/streamText
 */
function buildGenerateOptions(
  model: ReturnType<import("@ai-sdk/provider").ProviderV3["languageModel"]>,
  messages: ModelMessage[],
  tools: ToolSet | undefined,
  request: ChatCompletionRequest,
  providerOptions: Record<string, unknown> | undefined,
  abortSignal: AbortSignal,
) {
  const baseOptions = {
    model,
    messages,
    tools,
    temperature: request.temperature,
    maxTokens: request.max_tokens,
    topP: request.top_p,
    frequencyPenalty: request.frequency_penalty,
    presencePenalty: request.presence_penalty,
    stopSequences: request.stop
      ? Array.isArray(request.stop)
        ? request.stop
        : [request.stop]
      : undefined,
    abortSignal,
  };

  return providerOptions ? { ...baseOptions, providerOptions } : baseOptions;
}

/**
 * Convert AI SDK finish reason to OpenAI format
 */
function convertFinishReason(
  reason: string | undefined,
): "stop" | "length" | "tool_calls" {
  if (reason === "tool-calls") return "tool_calls";
  if (reason === "length") return "length";
  return "stop";
}

// ============================================================================
// Route Handler
// ============================================================================

const app = new Hono<{ Variables: { meshContext: StudioContext } }>();

app.post("/:org/v1/chat/completions", async (c) => {
  const ctx = c.get("meshContext");
  const orgSlug = c.req.param("org");

  try {
    // 1. Validate API key authentication (this endpoint only supports API keys, not user sessions)
    if (!ctx.auth.apiKey?.id) {
      return c.json(
        createErrorResponse(
          "API key authentication required. Provide a valid API key via Authorization header.",
          "authentication_error",
        ),
        401,
      );
    }

    // 2. Validate organization context
    if (!ctx.organization) {
      return c.json(
        createErrorResponse(
          "Organization context is required. Ensure your API key has organization metadata.",
          "invalid_request_error",
          "organization",
        ),
        400,
      );
    }

    if ((ctx.organization.slug ?? ctx.organization.id) !== orgSlug) {
      return c.json(
        createErrorResponse(
          "Organization mismatch. The API key's organization does not match the requested organization.",
          "invalid_request_error",
          "organization",
        ),
        403,
      );
    }

    // 3. Parse and validate request body
    const rawBody = await c.req.json();
    const parseResult = ChatCompletionRequestSchema.safeParse(rawBody);

    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0] ?? {
        message: "Invalid request",
        path: [],
      };
      return c.json(
        createErrorResponse(
          `Invalid request: ${firstError.message}`,
          "invalid_request_error",
          firstError.path.length > 0 ? firstError.path.join(".") : null,
        ),
        400,
      );
    }

    const request = parseResult.data;

    // 4. Parse model string
    const modelParsed = parseModelString(request.model);
    if (!modelParsed) {
      return c.json(
        createErrorResponse(
          "Invalid model format. Expected 'model_id' or 'credential_id:model_id' (e.g., 'claude-sonnet-4-6' or 'key_abc123:claude-sonnet-4-6')",
          "invalid_request_error",
          "model",
        ),
        400,
      );
    }

    let { credentialId } = modelParsed;
    const { modelId } = modelParsed;

    // 5. Resolve credential — use explicit or fall back to org's first key
    if (!credentialId) {
      const keys = await ctx.storage.aiProviderKeys.list({
        organizationId: ctx.organization.id,
      });
      if (keys.length === 0) {
        return c.json(
          createErrorResponse(
            "No AI provider credentials configured for this organization. " +
              "Add a credential in settings or specify one explicitly via 'credential_id:model_id'.",
            "invalid_request_error",
            "model",
          ),
          400,
        );
      }
      credentialId = keys[0]!.id;
    }

    // 6. Activate AI provider
    let provider;
    try {
      provider = await ctx.aiProviders.activate(
        credentialId,
        ctx.organization.id,
      );
    } catch {
      return c.json(
        createErrorResponse(
          `AI provider credential not found or inaccessible: ${credentialId}`,
          "invalid_request_error",
          "model",
        ),
        404,
      );
    }

    // 7. Create language model
    const languageModel = provider.aiSdk.languageModel(modelId);

    // 8. Convert messages, tools, and response format
    const messages = convertToAISDKMessages(request.messages);
    const tools = request.tools
      ? convertToAISDKTools(request.tools)
      : undefined;
    const providerOptions = convertResponseFormat(request.response_format);

    // 9. Prepare completion metadata
    const completionId = generateCompletionId();
    const created = Math.floor(Date.now() / 1000);

    // 10. Handle streaming vs non-streaming
    if (request.stream) {
      return streamSSE(c, async (stream) => {
        const options = buildGenerateOptions(
          languageModel,
          messages,
          tools,
          request,
          providerOptions,
          c.req.raw.signal,
        );

        try {
          const result = streamText(
            options as Parameters<typeof streamText>[0],
          );

          let sentRole = false;
          let toolCallIndex = 0;

          for await (const part of result.fullStream) {
            // Send initial role delta
            if (
              !sentRole &&
              (part.type === "text-delta" || part.type === "tool-call")
            ) {
              await stream.writeSSE({
                data: JSON.stringify({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: request.model,
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", content: "" },
                      finish_reason: null,
                    },
                  ],
                }),
              });
              sentRole = true;
            }

            if (part.type === "text-delta") {
              await stream.writeSSE({
                data: JSON.stringify({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: request.model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: part.text },
                      finish_reason: null,
                    },
                  ],
                }),
              });
            } else if (part.type === "tool-call") {
              const idx = toolCallIndex++;

              await stream.writeSSE({
                data: JSON.stringify({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: request.model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: idx,
                            id: part.toolCallId,
                            type: "function",
                            function: {
                              name: part.toolName,
                              arguments: JSON.stringify(part.input),
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                }),
              });
            } else if (part.type === "finish") {
              await stream.writeSSE({
                data: JSON.stringify({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: request.model,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: convertFinishReason(part.finishReason),
                    },
                  ],
                  usage: part.totalUsage
                    ? {
                        prompt_tokens: part.totalUsage.inputTokens ?? 0,
                        completion_tokens: part.totalUsage.outputTokens ?? 0,
                        total_tokens: part.totalUsage.totalTokens ?? 0,
                      }
                    : undefined,
                }),
              });
            }
          }

          await stream.writeSSE({ data: "[DONE]" });
        } catch (error) {
          const err = error as Error;
          console.error("[openai-compat:stream] Error:", err.message);
          await stream.writeSSE({
            data: JSON.stringify({
              error: {
                message: err.message,
                type: "server_error",
              },
            }),
          });
        }
      });
    } else {
      // Non-streaming response
      const options = buildGenerateOptions(
        languageModel,
        messages,
        tools,
        request,
        providerOptions,
        c.req.raw.signal,
      );

      const result = await generateText(
        options as Parameters<typeof generateText>[0],
      );

      // Build response message
      const responseMessage: {
        role: "assistant";
        content: string | null;
        tool_calls?: Array<{
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }>;
      } = {
        role: "assistant",
        content: result.text || null,
      };

      // Add tool calls if present
      if (result.toolCalls && result.toolCalls.length > 0) {
        responseMessage.tool_calls = result.toolCalls.map((tc) => ({
          id: tc.toolCallId,
          type: "function" as const,
          function: {
            name: tc.toolName,
            arguments: JSON.stringify("input" in tc ? tc.input : {}),
          },
        }));
        responseMessage.content = null;
      }

      return c.json({
        id: completionId,
        object: "chat.completion",
        created,
        model: request.model,
        choices: [
          {
            index: 0,
            message: responseMessage,
            finish_reason: convertFinishReason(result.finishReason),
          },
        ],
        usage: {
          prompt_tokens: result.usage?.inputTokens ?? 0,
          completion_tokens: result.usage?.outputTokens ?? 0,
          total_tokens: result.usage?.totalTokens ?? 0,
        },
      });
    }
  } catch (error) {
    const err = error as Error;

    if (err.name === "AbortError") {
      return c.json(
        createErrorResponse("Request aborted", "invalid_request_error"),
        400,
      );
    }

    // Handle message conversion validation errors (e.g., malformed JSON in tool call arguments)
    if (err.name === "MessageConversionError") {
      return c.json(
        createErrorResponse(err.message, "invalid_request_error", "messages"),
        400,
      );
    }

    console.error("[openai-compat] Error:", err.message, err.stack);
    return c.json(createErrorResponse(err.message, "server_error"), 500);
  }
});

export default app;
