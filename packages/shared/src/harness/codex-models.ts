export const CODEX_SUBSCRIPTION_PROVIDER_ID = "codex-subscription";
export const CODEX_DEFAULT_MODEL = "gpt-6.1-sol";

export function supportsCodex(providerId: string): boolean {
  return ["openai-compatible", "openrouter", "deco"].includes(providerId);
}

export function isCodexModel(providerId: string, modelId: string): boolean {
  return supportsCodex(providerId) && codexModelId(modelId) !== null;
}

/** Codex requires a Responses API model, rather than an arbitrary chat model. */
export function codexModelId(modelId: string): string | null {
  const id = modelId.replace(/^openai\//, "");
  return /^(gpt-\d|o[134](?:-|$))/.test(id) ? id : null;
}
