/**
 * A choice in the panel's top bar, drawn like the bar's other controls (the
 * day picker, "Connect a source"): an outline button that opens a menu, not
 * a form select, so the bar reads as one row of the same parts.
 */

import { ChevronDown } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";

export function TopbarSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  /** For assistive tech; the button shows the chosen option. */
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={label}
          className="gap-1 font-normal"
        >
          {current?.label ?? value}
          <ChevronDown size={14} className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            const option = options.find((o) => o.value === next);
            if (option) onChange(option.value);
          }}
        >
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
