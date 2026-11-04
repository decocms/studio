/**
 * A choice in the panel's top bar, drawn like the bar's other controls (the
 * day picker, "Connect a source"): an outline button that opens a menu, not
 * a form select, so the bar reads as one row of the same parts.
 */

import { Calendar, ChevronDown } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { useT } from "@/i18n/use-t.ts";

export function TopbarSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  period = false,
}: {
  /** For assistive tech, with the chosen option the button shows. */
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  /** A time window: drawn with the calendar, like the day picker beside it. */
  period?: boolean;
}) {
  const t = useT();
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={t("monitor.select.current", {
            label,
            value: current?.label ?? value,
          })}
          className="gap-1 font-normal"
        >
          {period && <Calendar size={14} />}
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
