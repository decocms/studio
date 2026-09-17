import type { OpenAIProvider } from "@ai-sdk/openai";

/**
 * Route languageModel() through /chat/completions instead of the OpenAI
 * Responses API (/responses), which llmapi and most OpenAI-compatible
 * servers don't support.
 */
export function useChatCompletions<T extends OpenAIProvider>(openai: T): T {
  return Object.assign(
    (...args: Parameters<OpenAIProvider>) => openai.chat(...args),
    openai,
    { languageModel: openai.chat },
  );
}
