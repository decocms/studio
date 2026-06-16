import {
  streamText as defaultStreamText,
  type LanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type StopCondition,
  type SystemModelMessage,
  type ToolSet,
} from "ai";
import { OPENROUTER_CACHE_PROVIDER_OPTIONS } from "./cache-instrumentation";

export interface NativeAgentLoopCoreOptions {
  model: LanguageModel;
  systemMessages: SystemModelMessage[];
  messages: ModelMessage[];
  tools: ToolSet;
  temperature?: number;
  maxOutputTokens: number;
  stopWhen: StopCondition<ToolSet>;
  abortSignal: AbortSignal;
  prepareStep?: unknown;
  onStepFinish?: unknown;
  onError?: (message: string, error: unknown) => void;
  streamText?: typeof defaultStreamText;
}

export interface NativeAgentLoopCoreHandle {
  result: StreamTextResult<ToolSet, never>;
  error: Promise<string | undefined>;
}

function stringifyProviderError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  // Provider/gateway errors often arrive as plain objects (e.g. the
  // `{ code, message, metadata }` shape a 504 idle timeout carries). Prefer a
  // string `message` field; `${error}` would otherwise log `[object Object]`.
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

export function runNativeAgentLoopCore(
  opts: NativeAgentLoopCoreOptions,
): NativeAgentLoopCoreHandle {
  let capturedError: string | undefined;
  let resolveError!: (err: string | undefined) => void;
  const error = new Promise<string | undefined>((resolve) => {
    resolveError = resolve;
  });
  const finalizeError = (message: string | undefined) => {
    if (capturedError === undefined) capturedError = message;
    resolveError(capturedError);
  };

  const streamTextFn = opts.streamText ?? defaultStreamText;
  const result = streamTextFn({
    model: opts.model,
    system: opts.systemMessages,
    messages: opts.messages,
    tools: opts.tools,
    providerOptions: OPENROUTER_CACHE_PROVIDER_OPTIONS,
    prepareStep: opts.prepareStep as never,
    temperature: opts.temperature,
    maxOutputTokens: opts.maxOutputTokens,
    stopWhen: opts.stopWhen,
    abortSignal: opts.abortSignal,
    onStepFinish: opts.onStepFinish as never,
    onError: async (event: { error?: unknown }) => {
      const rawError = event.error ?? event;
      const message = stringifyProviderError(rawError);
      opts.onError?.(message, rawError);
      finalizeError(message);
    },
    onAbort: async () => {
      finalizeError(capturedError ?? "Run aborted before completion.");
    },
  }) as StreamTextResult<ToolSet, never>;

  Promise.resolve(result.finishReason)
    .then(() => {
      if (capturedError === undefined) {
        resolveError(undefined);
      }
    })
    .catch((err) => {
      const message = stringifyProviderError(err);
      opts.onError?.(message, err);
      finalizeError(message);
    });

  return { result, error };
}
