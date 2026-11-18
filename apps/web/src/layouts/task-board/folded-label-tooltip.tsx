import { useRef, useState, type ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";

/** True once the header folded the button's `data-folding-label` down to sr-only. */
function labelFolded(trigger: HTMLElement | null): boolean {
  const label = trigger?.querySelector<HTMLElement>("[data-folding-label]");
  return !!label && label.getBoundingClientRect().width <= 1;
}

/** Names a header action whose label folded away; quiet while the label shows. */
export function FoldedLabelTooltip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => setOpen(next && labelFolded(trigger.current))}
    >
      <TooltipTrigger ref={trigger} asChild>
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
