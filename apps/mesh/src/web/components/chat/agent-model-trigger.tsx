import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import type { HarnessId } from "@/harnesses";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";
import type { ChatTier } from "@/tools/organization/schema";
import { getAgentModelSet } from "./select-model/agent-models";
import { SimpleModeTierDropdown } from "./simple-mode-tier-dropdown";

const TIER_ROWS: Array<{ tier: ChatTier; description: string }> = [
  { tier: "fast", description: "Quicker responses" },
  { tier: "smart", description: "Balanced quality" },
  { tier: "thinking", description: "Deeper reasoning" },
];

interface Props {
  agent: HarnessId | null;
  /** Required for the CLI variant — laptop harnesses only apply when the
   *  runner is the user's laptop. When this is `null` the trigger falls
   *  back to the generic Decopilot/Fast-Smart-Thinking pill, matching how
   *  the AgentPill resolves the active option. */
  sandboxKind: SandboxProviderKind | null;
  tier: ChatTier;
  onSelect: (tier: ChatTier) => void;
}

/**
 * Inline model trigger on the chat input. When the active agent is a
 * laptop-CLI harness (Claude Code / Codex), this renders the agent's logo
 * plus the current tier's model label (e.g. "Haiku"). Decopilot falls
 * back to the generic SimpleModeTierDropdown.
 *
 * The underlying state is still `simpleModeTier` — the same Fast/Smart/
 * Thinking slot drives Decopilot and the CLI agents alike, with the
 * per-agent model lookup happening in `getAgentModelSet`.
 */
export function AgentModelTrigger({
  agent,
  sandboxKind,
  tier,
  onSelect,
}: Props) {
  const isLaptopCli =
    sandboxKind === "remote-user" &&
    (agent === "claude-code" || agent === "codex");
  const modelSet = isLaptopCli && agent ? getAgentModelSet(agent) : null;

  if (!modelSet) {
    return <SimpleModeTierDropdown tier={tier} onSelect={onSelect} />;
  }

  const current = modelSet.tiers[tier];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="default"
          title={current.label}
          aria-label={current.label}
          className="text-muted-foreground hover:text-foreground gap-1.5"
        >
          <img
            src={modelSet.logo}
            alt=""
            className="size-4 rounded-sm dark:bg-white dark:rounded-sm dark:p-px"
          />
          <span className="inline-block overflow-hidden whitespace-nowrap max-w-0 opacity-0 transition-[max-width,opacity] duration-200 ease-out @[496px]/chat-bottom:max-w-32 @[496px]/chat-bottom:opacity-100">
            {current.label}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 p-1.5">
        {TIER_ROWS.map(({ tier: rowTier, description }) => {
          const entry = modelSet.tiers[rowTier];
          return (
            <DropdownMenuItem key={rowTier} onSelect={() => onSelect(rowTier)}>
              <img
                src={modelSet.logo}
                alt=""
                className="size-4 rounded-sm dark:bg-white dark:rounded-sm dark:p-px"
              />
              <div className="flex flex-col gap-0.5 flex-1">
                <span>{entry.label}</span>
                <span className="text-xs text-muted-foreground font-normal">
                  {description}
                </span>
              </div>
              {tier === rowTier && (
                <span className="text-xs text-muted-foreground font-medium">
                  On
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
