import { createOpenAI } from "@ai-sdk/openai";
import { retry, RetryError } from "@decocms/shared/std";
import type { StudioProvider, ProviderAdapter, ModelInfo } from "../types";

/** A transient (5xx / 429) status from the models GET. */
class TransientModelsListError extends Error {}

/**
 * A GET is always safe to retry — no side effect. So a single flaky 5xx/429
 * from a custom endpoint doesn't fail the whole listModels call.
 */
async function fetchModelsWithRetry(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<Response> {
  try {
    return await retry(
      async () => {
        const res = await fetch(`${baseUrl}/models`, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status >= 500 || res.status === 429) {
          const body = await res.text().catch(() => "");
          throw new TransientModelsListError(
            `OpenAI-compatible listModels failed: ${res.status} ${body}`,
          );
        }
        return res;
      },
      {
        maxAttempts: 3,
        minTimeout: 200,
        maxTimeout: 2_000,
        isRetriable: (err) => err instanceof TransientModelsListError,
      },
    );
  } catch (err) {
    if (err instanceof RetryError && err.cause instanceof Error) {
      throw err.cause;
    }
    throw err;
  }
}

function parseCredential(raw: string): { baseUrl: string; apiKey: string } {
  const parsed = JSON.parse(raw);
  if (!parsed.baseUrl || typeof parsed.baseUrl !== "string") {
    throw new Error(
      "Invalid OpenAI-compatible credential: missing baseUrl field",
    );
  }
  // Normalize: strip trailing slashes, ensure /v1 suffix.
  // The AI SDK appends /chat/completions directly to the baseURL,
  // so it must end with /v1 for standard OpenAI-compatible servers.
  let url = parsed.baseUrl.replace(/\/+$/, "");
  if (!url.endsWith("/v1")) url += "/v1";
  return { baseUrl: url, apiKey: parsed.apiKey ?? "" };
}

const OPENAI_LOGO =
  "https://assets.decocache.com/decocms/d138aa7e-5b8c-4821-9e64-6aff40df2cdc/ChatGPT_logo.svg";

export const openaiCompatibleAdapter: ProviderAdapter = {
  info: {
    id: "openai-compatible",
    name: "OpenAI Compatible",
    description: "Custom OpenAI-compatible endpoint",
    logo: OPENAI_LOGO,
  },

  supportedMethods: ["api-key"],

  create(rawCredential): StudioProvider {
    const { baseUrl, apiKey } = parseCredential(rawCredential);

    const openai = createOpenAI({
      baseURL: baseUrl,
      apiKey: apiKey || "not-needed",
      name: "openai-compatible",
    });

    // Wrap so that languageModel() uses the chat completions API
    // (/v1/chat/completions) instead of the OpenAI Responses API (/responses)
    // which most compatible servers don't support.
    const aiSdk: typeof openai = Object.assign(
      (...args: Parameters<typeof openai>) => openai.chat(...args),
      openai,
      { languageModel: openai.chat },
    );

    return {
      info: this.info,
      aiSdk,

      async listModels(): Promise<ModelInfo[]> {
        const headers: Record<string, string> = {};
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

        const res = await fetchModelsWithRetry(baseUrl, headers);
        if (!res.ok) {
          throw new Error(`OpenAI-compatible listModels failed: ${res.status}`);
        }
        const body: { data: Array<{ id: string; owned_by?: string }> } =
          await res.json();
        return body.data.map((m) => ({
          providerId: "openai-compatible",
          modelId: m.id,
          title: m.id,
          description: m.owned_by ? `Owned by ${m.owned_by}` : null,
          logo: null,
          capabilities: [],
          limits: null,
          costs: null,
        }));
      },
    };
  },
};
