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

/**
 * A default of `[]` is a NEW array on every render, so anything derived from
 * it re-renders even when nothing changed. `never[]` is assignable to any
 * `T[]`, so one frozen constant serves every optional list prop in this file.
 */
const EMPTY_ARRAY: never[] = [];

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
  defaultValue = EMPTY_ARRAY,
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

  // Vendored shadcn shape. A render-time prev-guard would be the textbook fix,
  // but it also changes when a local selection survives a parent re-render —
  // a behavioural change to a published component that does not belong in a
  // lint sweep.
  // oxlint-disable react/set-state-in-effect
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  React.useEffect(() => {
    if (JSON.stringify(selectedValues) !== JSON.stringify(defaultValue)) {
      setSelectedValues(defaultValue);
    }
  }, [defaultValue, selectedValues]);
  // oxlint-enable react/set-state-in-effect

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
            /* The input treatment, so the trigger reads as a field, not a button. */
            "data-[placeholder]:text-muted-foreground flex h-(--studio-control-height) min-h-(--studio-control-height) w-full max-w-xs items-center justify-between gap-(--space-xs) rounded-(--studio-control-radius) bg-[var(--studio-input-background)] px-(--space-s) py-(--space-xs) text-s font-regular text-foreground shadow-(--edge) hover:bg-[var(--studio-input-background)] hover:shadow-[0_0_0_var(--border-s)_var(--neutral-5)] aria-invalid:shadow-[0_0_0_var(--border-s)_var(--error)] disabled:cursor-not-allowed disabled:bg-neutral-3 disabled:text-neutral-6 disabled:shadow-[0_0_0_var(--border-s)_var(--neutral-4-transparent)]",
            className,
          )}
          disabled={disabled}
        >
          {selectedValues.length > 0 ? (
            <div className="flex items-center justify-between w-full min-w-0">
              <div className="flex items-center gap-(--space-xxs) min-w-0 flex-1">
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
              <div className="flex items-center shrink-0 ml-(--space-xs)">
                <ChevronDown
                  size={20}
                  className="shrink-0 text-muted-foreground"
                />
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between w-full">
              <span className="text-s text-muted-foreground">
                {placeholder}
              </span>
              <ChevronDown
                size={20}
                className="shrink-0 text-muted-foreground"
              />
            </div>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 max-w-xs rounded-m"
        align="start"
        onEscapeKeyDown={() => setIsPopoverOpen(false)}
      >
        <Command shouldFilter={!onSearchChange} className="rounded-m">
          <CommandInput
            placeholder="Search..."
            onKeyDown={handleInputKeyDown}
            onValueChange={onSearchChange}
            className="rounded-t-s"
          />
          <CommandList className="rounded-b-s">
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
                    className="mr-(--space-xs) [&_svg]:!text-primary-foreground"
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
                        className="mr-(--space-xs) [&_svg]:!text-primary-foreground"
                        onClick={(e) => e.stopPropagation()}
                      />
                      {option.icon && (
                        <option.icon className="mr-(--space-xs) size-4 text-muted-foreground" />
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
