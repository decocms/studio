"use client";

import { Check, ChevronSelectorVertical } from "@untitledui/icons";
import { ComponentProps, ReactNode, useState } from "react";

import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";

export interface ComboboxOption {
  value: string;
  label: string;
  [key: string]: unknown; // Allow additional properties for custom rendering
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  triggerClassName?: string;
  contentClassName?: string;
  width?: string;
  renderTrigger?: (selectedOption?: ComboboxOption) => ReactNode;
  renderItem?: (option: ComboboxOption, isSelected: boolean) => ReactNode;
  emptyMessage?: string;
  searchPlaceholder?: string;
  /** Override how the search matches. Omitted keeps cmdk's fuzzy default, which
   *  scores subsequences — fine for short lists, noisy once there are dozens of
   *  similarly-worded options. */
  filter?: ComponentProps<typeof Command>["filter"];
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Select...",
  triggerClassName,
  contentClassName,
  width = "w-[200px]",
  renderTrigger,
  renderItem,
  emptyMessage = "No results found.",
  searchPlaceholder = "Search...",
  filter,
}: ComboboxProps) {
  const selectedOption = options.find((option) => option.value === value);
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {renderTrigger ? (
          <div className={cn("cursor-pointer", triggerClassName)}>
            {renderTrigger(selectedOption)}
          </div>
        ) : (
          <Button
            variant="outline"
            role="combobox"
            className={cn("justify-between", width, triggerClassName)}
          >
            {selectedOption ? selectedOption.label : placeholder}
            <ChevronSelectorVertical className="opacity-50" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        className={cn("p-0", contentClassName)}
        style={{ width: "var(--radix-popover-trigger-width)" }}
      >
        <Command filter={filter}>
          <CommandInput placeholder={searchPlaceholder} className="h-9" />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = value === option.value;
                return (
                  <CommandItem
                    key={option.value}
                    value={option.label}
                    onSelect={(currentLabel) => {
                      const currentValue = options.find(
                        (option) => option.label === currentLabel,
                      )?.value;
                      onChange(
                        currentValue === value ? "" : (currentValue ?? ""),
                      );
                      setOpen(false);
                    }}
                  >
                    {renderItem ? (
                      renderItem(option, isSelected)
                    ) : (
                      <>
                        {option.label}
                        <Check
                          className={cn(
                            "ml-auto",
                            isSelected ? "opacity-100" : "opacity-0",
                          )}
                        />
                      </>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
