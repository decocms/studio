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
} from "../../shared/gemini-interactions";
import type { DecopilotSecretModelSource } from "../types";
import type { MeshProvider } from "./mesh-provider";

export interface ResolvedSecretProvider extends MeshProvider {
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
      return withProviderSurface(
        source,
        Object.assign(aiSdk, {
          languageModel: (...args: Parameters<typeof aiSdk.languageModel>) =>
            aiSdk.languageModel(...args),
        }) as ProviderV3,
      );
    }

    case "openai-compatible": {
      let normalizedBaseUrl = (baseUrl ?? "").replace(/\/+$/, "");
      if (normalizedBaseUrl && !normalizedBaseUrl.endsWith("/v1")) {
        normalizedBaseUrl += "/v1";
      }
      const openai = createOpenAI({
        apiKey: apiKey || "not-needed",
        name: "openai-compatible",
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
          "Supported: anthropic, google, openrouter, deco, openai-compatible.",
      );
  }
}
