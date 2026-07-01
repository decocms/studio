import { cn } from "@deco/ui/lib/utils.ts";
import {
  BRAZIL_MAP_ROOT_TRANSFORM,
  BRAZIL_MAP_VIEWBOX,
  BRAZIL_STATES,
} from "./brazil-states";

interface BrazilMapProps {
  /** Currently selected region code (e.g. "SP"), or empty when none. */
  selected: string;
  /** Fired with the region code of the clicked state. */
  onSelect: (code: string) => void;
}

/**
 * Interactive SVG map of Brazil. Each state is a clickable path keyed by its
 * ISO 3166-2 subdivision code (without the BR- prefix), matching Cloudflare's
 * `cf-region-code`. Selecting a state emits that code.
 */
export function BrazilMap({ selected, onSelect }: BrazilMapProps) {
  return (
    <svg
      viewBox={BRAZIL_MAP_VIEWBOX}
      role="group"
      aria-label="Map of Brazil — select a state"
      className="h-72 w-full rounded-md border border-border/60 bg-muted/20"
    >
      <g transform={BRAZIL_MAP_ROOT_TRANSFORM}>
        {BRAZIL_STATES.map((state) => {
          const isSelected = state.code === selected;
          return (
            <g key={state.code} transform={state.gTransform}>
              <path
                d={state.d}
                transform={state.pathTransform}
                role="button"
                tabIndex={0}
                aria-label={state.name}
                aria-pressed={isSelected}
                onClick={() => onSelect(state.code)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(state.code);
                  }
                }}
                className={cn(
                  "cursor-pointer stroke-background outline-none transition-colors [stroke-width:1] [vector-effect:non-scaling-stroke]",
                  "hover:fill-primary/50 focus-visible:fill-primary/50",
                  isSelected ? "fill-primary" : "fill-muted-foreground/40",
                )}
              />
            </g>
          );
        })}
      </g>
    </svg>
  );
}
