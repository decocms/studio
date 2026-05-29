import { Switch } from "@deco/ui/components/switch.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";

/**
 * Enable/disable toggle for a connection or slot card. Wraps the design-system
 * Switch with a visible border and a stronger off-state track so it stands out
 * against the muted/tinted card footers — the default switch's `bg-input`
 * off-state blends into them.
 */
export function EnableToggle({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <Tooltip delayDuration={0}>
      {/* Wrap in a span: TooltipTrigger asChild would otherwise merge the
          tooltip's own data-state onto the Switch and clobber Radix Switch's
          checked/unchecked data-state, breaking all state-based styling. */}
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0">
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            aria-label={enabled ? "Disable" : "Enable"}
            className="border-muted-foreground/40 data-[state=unchecked]:bg-muted-foreground/40"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {enabled ? "Enabled" : "Disabled"}
      </TooltipContent>
    </Tooltip>
  );
}
