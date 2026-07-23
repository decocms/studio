/**
 * Build the provider surface Decopilot consumes from resolved secret model
 * sources. This file is portable into the desktop daemon: no cluster provider,
 * vault, storage, or `ai-providers/*` imports.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderV3 } from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  isInteractionsOnlyModel,
  pollInteraction,
  submitInteraction,
} from "./gemini-interactions";
import type { DecopilotSecretModelSource } from "../types";
import type { StudioProvider } from "./studio-provider";

export interface ResolvedSecretProvider extends StudioProvider {
  info: { id: never; name: string; description: string };
  aiSdk: ProviderV3;
  listModels(): Promise<never[]>;
}

function withProviderSurface(
  source: DecopilotSecretModelSource,
  aiSdk: ProviderV3,
  extras: Pick<ResolvedSecretProvider, "asyncResearch"> = {},
): ResolvedSecretProvider {
  return {
    info: {
      id: source.providerId as never,
      name: source.providerId,
      description: source.providerId,
    },
    aiSdk,
    ...extras,
    listModels: async () => {
      throw new Error(
        `Decopilot provider '${source.providerId}' was created from a resolved runtime secret and cannot list models.`,
      );
    },
  };
}

export function createProviderFromSecret(
  source: DecopilotSecretModelSource,
): ResolvedSecretProvider {
  const { providerId, apiKey, baseUrl, extraHeaders } = source;

  switch (providerId) {
    case "anthropic":
      return withProviderSurface(
        source,
        createAnthropic({
          apiKey,
          ...(baseUrl ? { baseURL: baseUrl } : {}),
          ...(extraHeaders ? { headers: extraHeaders } : {}),
        }),
      );

    case "google":
      return withProviderSurface(
        source,
        createGoogleGenerativeAI({
          apiKey,
          ...(baseUrl ? { baseURL: baseUrl } : {}),
          ...(extraHeaders ? { headers: extraHeaders } : {}),
        }),
        {
          asyncResearch: {
            canHandle: isInteractionsOnlyModel,
            start: async ({ modelId, query, abortSignal }) => {
              const { interactionId } = await submitInteraction({
                apiKey,
                agent: modelId,
                query,
                abortSignal,
              });
              return { jobId: interactionId };
            },
            resume: ({ jobId, abortSignal, onProgress, pollIntervalMs }) =>
              pollInteraction({
                apiKey,
                interactionId: jobId,
                abortSignal,
                onProgress,
                pollIntervalMs,
              }),
          },
        },
      );

    case "openrouter":
    case "deco": {
      const aiSdk = createOpenRouter({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        ...(extraHeaders ? { headers: extraHeaders } : {}),
      });
      // Capture the ORIGINAL factory before the Object.assign below overwrites
      // `aiSdk.languageModel`. A wrapper of the form `(...a) => aiSdk.languageModel(...a)`
      // would, post-assign, call ITSELF — a self-referential tail call that JSC
      // (Bun) tail-call-eliminates into a 100% CPU infinite loop (not a stack
      // overflow), wedging the desktop sandbox daemon on every decopilot run.
      const baseLanguageModel = aiSdk.languageModel.bind(aiSdk);
      return withProviderSurface(
        source,
        Object.assign(aiSdk, {
          languageModel: (...args: Parameters<typeof aiSdk.languageModel>) =>
            baseLanguageModel(...args),
        }) as ProviderV3,
      );
    }

    case "llmapi":
    case "openai-compatible": {
      // llmapi is a fixed-endpoint OpenAI-compatible gateway; openai-compatible
      // is user-configured. Both route languageModel() through chat completions.
      let normalizedBaseUrl = (baseUrl ?? "").replace(/\/+$/, "");
      if (providerId === "llmapi" && !normalizedBaseUrl) {
        normalizedBaseUrl = "https://api.llmapi.ai/v1";
      }
      if (normalizedBaseUrl && !normalizedBaseUrl.endsWith("/v1")) {
        normalizedBaseUrl += "/v1";
      }
      const openai = createOpenAI({
        apiKey: apiKey || "not-needed",
        name: providerId,
        ...(normalizedBaseUrl ? { baseURL: normalizedBaseUrl } : {}),
        ...(extraHeaders ? { headers: extraHeaders } : {}),
      });
      return withProviderSurface(
        source,
        Object.assign(openai, {
          languageModel: (...args: Parameters<typeof openai.chat>) =>
            openai.chat(...args),
        }) as ProviderV3,
      );
    }

    default:
      throw new Error(
        `decopilot: unsupported modelSource.providerId '${providerId}'. ` +
          "Supported: anthropic, google, openrouter, deco, openai-compatible, llmapi.",
      );
  }
}
