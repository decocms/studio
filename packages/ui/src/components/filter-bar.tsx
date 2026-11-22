/* eslint-disable ban-memoization/ban-memoization */
import { useMemo, useState, type ReactNode } from "react";

import { Button } from "./button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu.tsx";
import { Input } from "./input.tsx";
import { ArrowLeft, X, Plus } from "@untitledui/icons";

/**
 * A default of `[]` is a NEW array on every render, so anything derived from
 * it re-renders even when nothing changed. `never[]` is assignable to any
 * `T[]`, so one frozen constant serves every optional list prop in this file.
 */
const EMPTY_ARRAY: never[] = [];

export type FilterOperator =
  | "contains"
  | "does_not_contain"
  | "is"
  | "is_not"
  | "in_last"
  | "before"
  | "after"
  | "between";

export type FilterColumn =
  | "name"
  | "description"
  | "created_at"
  | "updated_at"
  | "created_by"
  | "updated_by";

export interface Filter {
  id: string;
  column: FilterColumn;
  operator: FilterOperator;
  value: string;
}

export interface FilterBarUser {
  id: string;
  name?: string;
}

interface FilterBarProps {
  filters: Filter[];
  onFiltersChange: (filters: Filter[]) => void;
  availableUsers?: FilterBarUser[];
  renderUserItem?: (user: FilterBarUser) => ReactNode;
  renderUserFilter?: (props: {
    users: FilterBarUser[];
    onSelect: (userId: string) => void;
  }) => ReactNode;
}

const COLUMN_LABELS: Record<FilterColumn, string> = {
  name: "Name",
  description: "Description",
  created_at: "Date created",
  updated_at: "Date updated",
  created_by: "Created by",
  updated_by: "Updated by",
};

const TEXT_OPERATORS: Record<string, string> = {
  contains: "contains",
  does_not_contain: "does not contain",
  is: "is",
  is_not: "is not",
};

const USER_OPERATORS: Record<string, string> = {
  is: "is",
};

const DATE_PRESETS = [
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
  { label: "Last 3 months", value: "3m" },
  { label: "All time", value: "all" },
];

function getOperatorsForColumn(column: FilterColumn): Record<string, string> {
  if (column === "name" || column === "description") {
    return TEXT_OPERATORS;
  }
  if (column === "created_by" || column === "updated_by") {
    return USER_OPERATORS;
  }
  return { in_last: "in last" };
}

function getDefaultOperatorForAutoStep(
  column: FilterColumn,
): FilterOperator | null {
  if (column === "created_by" || column === "updated_by") {
    return "is";
  }
  if (column === "created_at" || column === "updated_at") {
    return "in_last";
  }
  return null;
}

function getDefaultValue(column: FilterColumn): string {
  if (column === "created_at" || column === "updated_at") {
    return "7d";
  }
  return "";
}

export function FilterBar({
  filters,
  onFiltersChange,
  availableUsers = EMPTY_ARRAY,
  renderUserItem,
  renderUserFilter,
}: FilterBarProps) {
  const [addingFilter, setAddingFilter] = useState(false);
  const [selectedColumn, setSelectedColumn] = useState<FilterColumn | null>(
    null,
  );
  const [selectedOperator, setSelectedOperator] =
    useState<FilterOperator | null>(null);
  const [filterValue, setFilterValue] = useState<string>("");
  const [editingFilterId, setEditingFilterId] = useState<string | null>(null);

  const userLookup = useMemo(() => {
    return new Map(availableUsers.map((user) => [user.id, user]));
  }, [availableUsers]);

  function addFilter(
    column: FilterColumn,
    operator: FilterOperator,
    value: string,
  ) {
    if (editingFilterId) {
      onFiltersChange(
        filters.map((f) =>
          f.id === editingFilterId ? { id: f.id, column, operator, value } : f,
        ),
      );
    } else {
      const newFilter: Filter = {
        id: crypto.randomUUID(),
        column,
        operator,
        value,
      };
      onFiltersChange([...filters, newFilter]);
    }
    resetAddFilter();
  }

  function removeFilter(filterId: string) {
    onFiltersChange(filters.filter((f) => f.id !== filterId));
  }

  function resetAddFilter() {
    setAddingFilter(false);
    setSelectedColumn(null);
    setSelectedOperator(null);
    setFilterValue("");
    setEditingFilterId(null);
  }

  function getFilterLabel(filter: Filter): string {
    const columnLabel = COLUMN_LABELS[filter.column];

    if (filter.column === "name" || filter.column === "description") {
      const operators = getOperatorsForColumn(filter.column);
      const operatorLabel = operators[filter.operator] || filter.operator;
      return `${columnLabel} ${operatorLabel} "${filter.value}"`;
    }

    if (filter.column === "created_at" || filter.column === "updated_at") {
      const preset = DATE_PRESETS.find((p) => p.value === filter.value);
      const valueLabel = preset ? preset.label : filter.value;
      return `${columnLabel}: ${valueLabel}`;
    }

    return columnLabel;
  }

  function renderUserSelection(onSelect: (userId: string) => void) {
    if (renderUserFilter) {
      return renderUserFilter({ users: availableUsers, onSelect });
    }

    return (
      <Command className="border-0">
        <CommandInput
          placeholder="Search users..."
          className="h-(--studio-control-height)"
        />
        <CommandList>
          <CommandEmpty>No users found.</CommandEmpty>
          <CommandGroup>
            {availableUsers.map((user) => (
              <CommandItem
                key={user.id}
                onSelect={() => {
                  onSelect(user.id);
                }}
              >
                {renderUserItem ? (
                  renderUserItem(user)
                ) : (
                  <span className="truncate">{user.name ?? user.id}</span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    );
  }

  function renderDropdownContent() {
    if (!selectedColumn) {
      return (
        <>
          <div className="px-(--space-xs) py-(--space-xxs)">
            <p className="text-s font-medium text-neutral-6">
              Select to filter
            </p>
          </div>
          {Object.entries(COLUMN_LABELS).map(([key, label]) => (
            <DropdownMenuItem
              key={key}
              onSelect={(e) => {
                e.preventDefault();
                const col = key as FilterColumn;
                setSelectedColumn(col);
                setSelectedOperator(getDefaultOperatorForAutoStep(col));
                setFilterValue(getDefaultValue(col));
              }}
            >
              {label}
            </DropdownMenuItem>
          ))}
        </>
      );
    }

    if (!selectedOperator) {
      return (
        <>
          <div className="px-(--space-xs) py-(--space-xxs) flex items-center gap-(--space-xs)">
            <Button
              variant="ghost"
              size="icon"
              className="size-(--studio-control-height-xs)"
              onClick={() => {
                setSelectedColumn(null);
                setSelectedOperator(null);
              }}
            >
              <ArrowLeft size={16} />
            </Button>
            <p className="text-s font-medium text-neutral-6">
              {COLUMN_LABELS[selectedColumn]}
            </p>
          </div>
          <DropdownMenuSeparator />
          {Object.entries(getOperatorsForColumn(selectedColumn)).map(
            ([key, label]) => (
              <DropdownMenuItem
                key={key}
                onSelect={(e) => {
                  e.preventDefault();
                  setSelectedOperator(key as FilterOperator);
                }}
              >
                {label}
              </DropdownMenuItem>
            ),
          )}
        </>
      );
    }

    if (
      (selectedColumn === "created_by" || selectedColumn === "updated_by") &&
      availableUsers.length === 0 &&
      !renderUserFilter
    ) {
      return (
        <div className="px-(--space-xs) py-(--space-s) text-s font-regular text-muted-foreground">
          No users available for filtering.
        </div>
      );
    }

    return (
      <>
        <div className="px-(--space-xs) py-(--space-xxs) flex items-center gap-(--space-xs)">
          <Button
            variant="ghost"
            size="icon"
            className="size-(--studio-control-height-xs)"
            onClick={() => {
              if (
                selectedColumn === "name" ||
                selectedColumn === "description"
              ) {
                setSelectedOperator(null);
              } else {
                setSelectedColumn(null);
                setSelectedOperator(null);
              }
            }}
          >
            <ArrowLeft size={16} />
          </Button>
          <p className="text-s font-medium text-neutral-6">
            {selectedColumn === "name" || selectedColumn === "description"
              ? `${COLUMN_LABELS[selectedColumn]} ${getOperatorsForColumn(selectedColumn)[selectedOperator]}`
              : COLUMN_LABELS[selectedColumn]}
          </p>
        </div>
        <DropdownMenuSeparator />

        {(selectedColumn === "name" || selectedColumn === "description") && (
          <div className="p-(--space-xs)">
            <Input
              autoFocus
              placeholder="Enter value..."
              value={filterValue}
              onChange={(e) => setFilterValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filterValue) {
                  addFilter(selectedColumn, selectedOperator, filterValue);
                }
              }}
            />
            <Button
              size="sm"
              className="w-full mt-(--space-xs)"
              onClick={() => {
                if (filterValue) {
                  addFilter(selectedColumn, selectedOperator, filterValue);
                }
              }}
              disabled={!filterValue}
            >
              Apply
            </Button>
          </div>
        )}

        {(selectedColumn === "created_by" || selectedColumn === "updated_by") &&
          renderUserSelection((userId) => {
            addFilter(selectedColumn, selectedOperator, userId);
          })}

        {(selectedColumn === "created_at" || selectedColumn === "updated_at") &&
          DATE_PRESETS.map((preset) => (
            <DropdownMenuItem
              key={preset.value}
              onSelect={(e) => {
                e.preventDefault();
                addFilter(selectedColumn, selectedOperator, preset.value);
              }}
            >
              {preset.label}
            </DropdownMenuItem>
          ))}
      </>
    );
  }

  return (
    <div className="flex items-center gap-(--space-xs) flex-wrap">
      {filters.map((filter) => {
        const isUserFilter =
          (filter.column === "created_by" || filter.column === "updated_by") &&
          filter.value;
        const userData = isUserFilter
          ? (userLookup.get(filter.value) ?? { id: filter.value })
          : undefined;

        return (
          <DropdownMenu
            key={filter.id}
            open={addingFilter && editingFilterId === filter.id}
            onOpenChange={(open) => {
              if (!open && editingFilterId === filter.id) {
                resetAddFilter();
              }
            }}
          >
            <DropdownMenuTrigger asChild>
              <div
                className="group flex h-(--studio-control-height-sm) cursor-pointer items-center gap-(--space-xxs) rounded-(--studio-control-radius) bg-(--chip) px-(--space-s) text-s font-medium text-(color:--chip-foreground) transition-colors duration-(--motion-duration) ease-motion hover:bg-neutral-4"
                onClick={() => {
                  setEditingFilterId(filter.id);
                  setSelectedColumn(filter.column);

                  if (
                    filter.column === "name" ||
                    filter.column === "description"
                  ) {
                    setSelectedOperator(filter.operator);
                  } else {
                    setSelectedOperator(
                      getDefaultOperatorForAutoStep(filter.column),
                    );
                  }

                  setFilterValue(filter.value);
                  setAddingFilter(true);
                }}
              >
                {isUserFilter ? (
                  <div className="flex items-center gap-(--space-xs)">
                    <span className="text-muted-foreground">
                      {COLUMN_LABELS[filter.column]}:
                    </span>
                    {renderUserItem ? (
                      renderUserItem(userData!)
                    ) : (
                      <span className="text-foreground">
                        {userData?.name ?? userData?.id}
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="text-foreground">
                    {getFilterLabel(filter)}
                  </span>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFilter(filter.id);
                  }}
                  className="flex items-center justify-center w-0 opacity-0 group-hover:w-4 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-[width,opacity,color] duration-(--motion-duration) ease-motion overflow-hidden"
                >
                  <X size={16} />
                </button>
              </div>
            </DropdownMenuTrigger>
            {addingFilter && editingFilterId === filter.id && (
              <DropdownMenuContent align="start" className="w-64">
                {renderDropdownContent()}
              </DropdownMenuContent>
            )}
          </DropdownMenu>
        );
      })}

      <DropdownMenu
        open={addingFilter && !editingFilterId}
        onOpenChange={(open) => {
          if (!open) {
            resetAddFilter();
          } else {
            setAddingFilter(open);
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
          >
            <Plus size={16} />
            Add filter
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {renderDropdownContent()}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
