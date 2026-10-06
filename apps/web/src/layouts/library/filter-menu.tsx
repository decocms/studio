/** A filter in the Library's top bar: a pill naming its current choice, and a
 *  menu of the others. It reads as active once it narrows anything. */

import type { ReactNode } from "react";
import { ChevronDown } from "@untitledui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { Page } from "@/components/page";

export function FilterMenu<T extends string>({
  label,
  value,
  options,
  active,
  onChange,
}: {
  label: ReactNode;
  value: T;
  options: readonly { value: T; label: string }[];
  active: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Page.Tab active={active}>
          {label}
          <ChevronDown size={14} />
        </Page.Tab>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            const option = options.find((o) => o.value === next);
            if (option) onChange(option.value);
          }}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
