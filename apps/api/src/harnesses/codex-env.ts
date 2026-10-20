import {
  CODEX_DEFAULT_MODEL,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  codexModelId,
  supportsCodex,
} from "@decocms/shared/harness/codex-models";
import type { ClaudeCodeCredential } from "./claude-code-env";

export function codexEnvFromCredential(
  credential: ClaudeCodeCredential,
  chosenModel?: string,
): Record<string, string | null> {
  const subscription = credential.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID;
  if (!subscription && !supportsCodex(credential.providerId)) {
    throw new Error(
      "Codex needs a linked ChatGPT subscription or a provider with an OpenAI Responses API endpoint.",
    );
  }
  const model =
    (chosenModel && codexModelId(chosenModel)) || CODEX_DEFAULT_MODEL;
  const baseUrl =
    credential.baseUrl ??
    (credential.providerId === "openrouter"
      ? "https://openrouter.ai/api/v1"
      : null);
  if (!subscription && !baseUrl)
    throw new Error("The Codex provider needs a Responses API base URL.");
  return {
    CODEX_MODEL:
      !subscription && ["openrouter", "deco"].includes(credential.providerId)
        ? `openai/${model}`
        : model,
    STUDIO_CODEX_AUTH_JSON: subscription ? credential.apiKey : null,
    CODEX_API_KEY: subscription ? null : credential.apiKey,
    OPENAI_API_KEY: null,
    OPENAI_BASE_URL: subscription ? null : baseUrl,
    CODEX_ACCESS_TOKEN: null,
    CLAUDE_CODE_OAUTH_TOKEN: null,
    ANTHROPIC_API_KEY: null,
    ANTHROPIC_AUTH_TOKEN: null,
    ANTHROPIC_BASE_URL: null,
  };
}

export function codexSubscriptionChatModel() {
  return {
    credentialId: CODEX_SUBSCRIPTION_PROVIDER_ID,
    thinking: {
      id: CODEX_DEFAULT_MODEL,
      title: CODEX_DEFAULT_MODEL,
      provider: "openai",
    },
  };
}
