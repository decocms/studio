/**
 * Commands that install the `decocms-studio` skill and log its CLI in. The
 * skill ships as a plugin in this repo's marketplace
 * (`.claude-plugin/marketplace.json`, source `apps/api/plugin`).
 */

import type { ConnectClient } from "@/components/connect/install-snippet";

/** The CLI's own default target, which needs no `--target`. */
const DEFAULT_TARGET = "https://studio.decocms.com";

const SKILLS_ADD = "npx skills add decocms/studio --skill decocms-studio -g";

/** "Other" leaves out `-a`, so the `skills` CLI asks which agents to add it to. */
export function skillInstallCommand(client: ConnectClient): string {
  switch (client) {
    case "claude-code":
      // Re-adding the marketplace is a no-op, so both lines are safe to rerun.
      return [
        "claude plugin marketplace add decocms/studio",
        "claude plugin install decocms-studio@decocms",
      ].join("\n");
    case "cursor":
      return `${SKILLS_ADD} -a cursor`;
    case "codex":
      return `${SKILLS_ADD} -a codex`;
    case "raw":
      return SKILLS_ADD;
  }
}

export function cliLoginCommand(origin: string): string {
  return origin === DEFAULT_TARGET
    ? "bunx decocms@latest auth login"
    : `bunx decocms@latest auth login --target ${origin}`;
}
