import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { ChevronDown } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { AGENT_OPTION_LABELS, type AgentOption } from "./agent-options";

const DECOPILOT_LOGO =
  "https://assets.decocache.com/decocms/fd07a578-6b1c-40f1-bc05-88a3b981695d/f7fc4ffa81aec04e37ae670c3cd4936643a7b269.png";
const CLAUDE_LOGO =
  "https://decoims.com/decocms/93e4059c-e598-412b-87eb-54d72a946ec8/claude-stroke-rounded.svg";
const CODEX_LOGO =
  "https://decoims.com/decocms/9170ffd4-b9cc-4661-ad8f-ae2eea019e00/codex.svg";

function logoFor(option: AgentOption): string {
  if (option === "claude-code-laptop") return CLAUDE_LOGO;
  if (option === "codex-laptop") return CODEX_LOGO;
  return DECOPILOT_LOGO;
}

function OptionIcon({ option }: { option: AgentOption }): ReactNode {
  return <img src={logoFor(option)} alt="" className="size-3.5" />;
}

interface AgentPillProps {
  options: AgentOption[];
  current: AgentOption | null;
  locked: boolean;
  onSelect: (option: AgentOption) => void;
  /** Optional footer slot — used for the "Connect laptop" CTA later. */
  footer?: ReactNode;
}

export function AgentPill({
  options,
  current,
  locked,
  onSelect,
  footer,
}: AgentPillProps) {
  if (options.length === 0 && !locked) return null;
  const active = current ?? options[0];
  if (!active) return null;

  // Min-width sized to fit the longest label ("Claude Code desktop") so the
  // pill stays visually stable when the user switches between options.
  const PILL_MIN_WIDTH = "min-w-[10.75rem]";

  if (locked) {
    return (
      <span
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-muted px-2 text-xs",
          PILL_MIN_WIDTH,
        )}
        title="Fixed for this thread"
      >
        <OptionIcon option={active} />
        {AGENT_OPTION_LABELS[active]}
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-7 gap-1.5 px-2 text-xs justify-start",
            PILL_MIN_WIDTH,
          )}
        >
          <OptionIcon option={active} />
          <span className="flex-1 truncate text-left">
            {AGENT_OPTION_LABELS[active]}
          </span>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onSelect(opt)}
            className={cn(
              "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
              active === opt && "bg-accent/50",
            )}
          >
            <OptionIcon option={opt} />
            {AGENT_OPTION_LABELS[opt]}
          </button>
        ))}
        {footer && (
          <>
            <div className="my-1 h-px bg-border" />
            {footer}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
