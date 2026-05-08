import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { Atom01, Lightning01, Stars01 } from "@untitledui/icons";

export type SimpleModeTier = "fast" | "smart" | "thinking";

const SIMPLE_MODE_TIER_OPTIONS = [
  {
    value: "fast" as const,
    label: "Fast",
    Icon: Lightning01,
    description: "Quicker responses",
  },
  {
    value: "smart" as const,
    label: "Smart",
    Icon: Stars01,
    description: "Balanced quality",
  },
  {
    value: "thinking" as const,
    label: "Thinking",
    Icon: Atom01,
    description: "Deeper reasoning",
  },
] as const;

export function SimpleModeTierDropdown({
  tier,
  onSelect,
}: {
  tier: SimpleModeTier;
  onSelect: (t: SimpleModeTier) => void;
}) {
  const current =
    SIMPLE_MODE_TIER_OPTIONS.find((o) => o.value === tier) ??
    SIMPLE_MODE_TIER_OPTIONS[1]!;
  const Icon = current.Icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="text-muted-foreground hover:text-foreground"
        >
          <Icon size={14} />
          <span className="hidden sm:inline">{current.label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52 p-1.5">
        {SIMPLE_MODE_TIER_OPTIONS.map(
          ({ value, label, Icon: TierIcon, description }) => (
            <DropdownMenuItem key={value} onSelect={() => onSelect(value)}>
              <TierIcon size={16} className="text-muted-foreground" />
              <div className="flex flex-col gap-0.5 flex-1">
                <span>{label}</span>
                <span className="text-xs text-muted-foreground font-normal">
                  {description}
                </span>
              </div>
              {tier === value && (
                <span className="text-xs text-muted-foreground font-medium">
                  On
                </span>
              )}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
