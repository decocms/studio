/**
 * The Claude versions Studio defaults to, named once.
 *
 * The same model has a different id on each route, and the harness defaults
 * (`claude-code-env.ts`) and the tier defaults (`default-model.ts`) both read
 * them from here, so a version bump is one edit and the two cannot disagree.
 */
export interface ClaudeModelIds {
  /** Anthropic's API and a linked Claude subscription. */
  anthropic: string;
  /** OpenRouter, and the Deco AI Gateway that provisions OpenRouter keys. */
  openrouter: string;
  /** GitHub Copilot's Anthropic-compatible endpoint. */
  copilot: string;
}

function claudeModelIds(
  family: "opus" | "sonnet",
  major: number,
  minor: number,
): ClaudeModelIds {
  return {
    anthropic: `claude-${family}-${major}-${minor}`,
    openrouter: `anthropic/claude-${family}-${major}.${minor}`,
    copilot: `claude-${family}-${major}.${minor}`,
  };
}

export const CLAUDE_OPUS = claudeModelIds("opus", 5, 5);
export const CLAUDE_SONNET = claudeModelIds("sonnet", 5, 5);
