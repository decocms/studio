/**
 * Which models the sandbox-hosted claude-code harness can run, by the provider
 * of the credential it runs on. The `claude` CLI only speaks to Claude models:
 * natively on an Anthropic key (or a linked Claude subscription), and through
 * OpenRouter's Anthropic-compatible endpoint on an OpenRouter or Deco key.
 */
const CLAUDE_CODE_MODEL_IDS: Record<string, RegExp> = {
  anthropic: /^claude-/,
  openrouter: /^anthropic\/claude-/,
  deco: /^anthropic\/claude-/,
};

export function isClaudeCodeModel(
  providerId: string,
  modelId: string,
): boolean {
  return CLAUDE_CODE_MODEL_IDS[providerId]?.test(modelId) ?? false;
}
