/**
 * Commands that install the `decocms-studio` skill and log its CLI in. The
 * skill ships as a plugin in this repo's marketplace
 * (`.claude-plugin/marketplace.json`, source `apps/api/plugin`).
 */

/** The CLI's own default target, which needs no `--target`. */
const DEFAULT_TARGET = "https://studio.decocms.com";

/** Re-adding the marketplace is a no-op, so both lines are safe to rerun. */
export const CLAUDE_CODE_SKILL_INSTALL = [
  "claude plugin marketplace add decocms/studio",
  "claude plugin install decocms-studio@decocms",
].join("\n");

/** Cursor, Codex and the other agents the `skills` CLI knows; it asks which. */
export const AGENTS_SKILL_INSTALL =
  "npx skills add decocms/studio --skill decocms-studio -g";

export function cliLoginCommand(origin: string): string {
  return origin === DEFAULT_TARGET
    ? "bunx decocms@latest auth login"
    : `bunx decocms@latest auth login --target ${origin}`;
}
