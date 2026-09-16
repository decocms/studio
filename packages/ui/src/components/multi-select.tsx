/* eslint-disable ban-memoization/ban-memoization */
"use client";

import * as React from "react";

import { cn } from "../lib/utils.ts";
import { Badge } from "./badge.tsx";
import { Button } from "./button.tsx";
import { Checkbox } from "./checkbox.tsx";
import { ChevronDown } from "@untitledui/icons";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";

export interface Option {
  label: string;
  value: string;
  icon?: React.ComponentType<{ className?: string }>;
}

interface MultiSelectProps {
  options: Option[];
  onValueChange: (value: string[]) => void;
  defaultValue?: string[];
  placeholder?: string;
  variant?: "default" | "secondary" | "destructive" | "outline";
  animation?: number;
  maxCount?: number;
  modalPopover?: boolean;
  asChild?: boolean;
  className?: string;
  disabled?: boolean;
  /** When provided, disables client-side filtering and delegates search to the caller. */
  onSearchChange?: (term: string) => void;
}

export function MultiSelect({
  options,
  onValueChange,
  defaultValue = [],
  placeholder = "Select items",
  variant = "default",
  animation = 0,
  maxCount = 3,
  modalPopover = false,
  asChild = false,
  className,
  disabled = false,
  onSearchChange,
}: MultiSelectProps) {
  const [selectedValues, setSelectedValues] =
    React.useState<string[]>(defaultValue);
  const [isPopoverOpen, setIsPopoverOpen] = React.useState(false);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  React.useEffect(() => {
    if (JSON.stringify(selectedValues) !== JSON.stringify(defaultValue)) {
      setSelectedValues(defaultValue);
    }
  }, [defaultValue, selectedValues]);

  const handleInputKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      setIsPopoverOpen(true);
    } else if (
      event.key === "Backspace" &&
      !(event.currentTarget as HTMLInputElement).value
    ) {
      const newSelectedValues = [...selectedValues];
      newSelectedValues.pop();
      setSelectedValues(newSelectedValues);
      onValueChange(newSelectedValues);
    }
  };

  const toggleOption = React.useCallback(
    (option: Option) => {
      const newSelectedValues = selectedValues.includes(option.value)
        ? selectedValues.filter((value) => value !== option.value)
        : [...selectedValues, option.value];
      setSelectedValues(newSelectedValues);
      onValueChange(newSelectedValues);
    },
    [selectedValues, onValueChange],
  );

  const handleClear = React.useCallback(() => {
    setSelectedValues([]);
    onValueChange([]);
  }, [onValueChange]);

  const handleTogglePopover = () => {
    setIsPopoverOpen((prev) => !prev);
  };

  const toggleAll = React.useCallback(() => {
    if (selectedValues.length === options.length) {
      handleClear();
    } else {
      const allValues = options.map((option) => option.value);
      setSelectedValues(allValues);
      onValueChange(allValues);
    }
  }, [selectedValues.length, options, handleClear, onValueChange]);

  return (
    <Popover
      open={isPopoverOpen}
      onOpenChange={setIsPopoverOpen}
      modal={modalPopover}
    >
      <PopoverTrigger asChild>
        <Button
          ref={null}
          {...(asChild ? {} : { variant: "outline" })}
          onClick={handleTogglePopover}
          className={cn(
            "border-input data-[placeholder]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/20 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 dark:hover:bg-input/50 flex w-full max-w-xs items-center justify-between gap-2 classic:rounded-xl border bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[2px] disabled:cursor-not-allowed disabled:opacity-50 h-10 min-h-10",
            className,
          )}
          disabled={disabled}
        >
          {selectedValues.length > 0 ? (
            <div className="flex items-center justify-between w-full min-w-0">
              <div className="flex items-center gap-1 min-w-0 flex-1">
                {selectedValues.slice(0, maxCount).map((value) => {
                  const option = options.find((o) => o.value === value);
                  const IconComponent = option?.icon;
                  return (
                    <Badge
                      key={value}
                      variant={variant === "default" ? "default" : "secondary"}
                      className="max-w-24"
                      style={{ animationDuration: `${animation}s` }}
                    >
                      {IconComponent && (
                        <IconComponent className="h-3 w-3 shrink-0" />
                      )}
                      <span className="truncate">{option?.label}</span>
                    </Badge>
                  );
                })}
                {selectedValues.length > maxCount && (
                  <Badge
                    variant={variant === "default" ? "default" : "secondary"}
                    className="flex-shrink-0"
                    style={{ animationDuration: `${animation}s` }}
                  >
                    +{selectedValues.length - maxCount}
                  </Badge>
                )}
              </div>
              <div className="flex items-center shrink-0 ml-2">
                <ChevronDown size={20} className="shrink-0 opacity-50" />
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between w-full">
              <span className="text-sm text-muted-foreground">
                {placeholder}
              </span>
              <ChevronDown size={20} className="shrink-0 opacity-50" />
            </div>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 max-w-xs rounded-xl"
        align="start"
        onEscapeKeyDown={() => setIsPopoverOpen(false)}
      >
        <Command shouldFilter={!onSearchChange} className="rounded-xl">
          <CommandInput
            placeholder="Search..."
            onKeyDown={handleInputKeyDown}
            onValueChange={onSearchChange}
            className="rounded-t-xl"
          />
          <CommandList className="rounded-b-xl">
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                key="all"
                onSelect={() => {
                  toggleAll();
                }}
                className="cursor-pointer"
              >
                <div
                  className="flex items-center w-full"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleAll();
                  }}
                >
                  <Checkbox
                    checked={
                      selectedValues.length === options.length &&
                      options.length > 0
                    }
                    onCheckedChange={toggleAll}
                    className="mr-2 [&_svg]:!text-primary-foreground"
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span>(Select All)</span>
                </div>
              </CommandItem>
              {options.map((option) => {
                const isSelected = selectedValues.includes(option.value);
                return (
                  <CommandItem
                    key={option.value}
                    onSelect={() => {
                      toggleOption(option);
                    }}
                    className="cursor-pointer"
                  >
                    <div
                      className="flex items-center w-full"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleOption(option);
                      }}
                    >
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => {
                          toggleOption(option);
                        }}
                        className="mr-2 [&_svg]:!text-primary-foreground"
                        onClick={(e) => e.stopPropagation()}
                      />
                      {option.icon && (
                        <option.icon className="mr-2 h-4 w-4 text-muted-foreground" />
                      )}
                      <span>{option.label}</span>
                    </div>
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
