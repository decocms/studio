import { useState } from "react";
import { DotsGrid, DotsHorizontal, Plus, Trash01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { isEmbeddedUnionResolveType } from "../block-type-utils";
import type { FieldProps } from "./field-props";
import { SchemaForm, renderField } from "../schema-form";

function getItemLabel(item: unknown, index: number): string {
  if (typeof item === "string") return item || `Item ${index + 1}`;
  if (typeof item === "number" || typeof item === "boolean")
    return String(item);
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>;
    for (const key of ["name", "label", "title", "alt", "text", "href", "id"]) {
      if (typeof obj[key] === "string" && obj[key]) return obj[key] as string;
    }
  }
  return `Item ${index + 1}`;
}

export function ArrayField({
  schema,
  value,
  onChange,
  path,
  label,
  breadcrumbPath = [],
  onBreadcrumbChange,
}: FieldProps) {
  const items = Array.isArray(value) ? value : [];
  const itemSchema = schema.items;
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const addItem = () => {
    const t = itemSchema?.type;
    const defaultVal =
      itemSchema?.default !== undefined
        ? itemSchema.default
        : t === "object"
          ? {}
          : t === "block-ref"
            ? (() => {
                const rt = itemSchema?.anyOfRefs?.[0]?.resolveType;
                if (typeof rt !== "string" || isEmbeddedUnionResolveType(rt)) {
                  return {};
                }
                return { __resolveType: rt };
              })()
            : t === "number" || t === "integer"
              ? 0
              : t === "boolean"
                ? false
                : t === "array"
                  ? []
                  : "";
    const next = [...items, defaultVal];
    onChange(next);
    const nextIndex = next.length - 1;
    setSelectedIndex(nextIndex);
    onBreadcrumbChange?.([
      ...breadcrumbPath,
      getItemLabel(defaultVal, nextIndex),
    ]);
  };

  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
    if (selectedIndex === index) {
      setSelectedIndex(null);
      onBreadcrumbChange?.(breadcrumbPath);
    }
  };

  const updateItem = (index: number, val: unknown) => {
    const next = [...items];
    next[index] = val;
    onChange(next);
    if (selectedIndex === index) {
      onBreadcrumbChange?.([...breadcrumbPath, getItemLabel(val, index)]);
    }
  };

  if (selectedIndex !== null && selectedIndex < items.length) {
    const item = items[selectedIndex];
    const itemBreadcrumbPath = [
      ...breadcrumbPath,
      getItemLabel(item, selectedIndex),
    ];
    return (
      <div className="min-w-0 space-y-4">
        {itemSchema?.type === "object" && itemSchema.properties ? (
          <SchemaForm
            schema={itemSchema}
            value={item}
            onChange={(val) => updateItem(selectedIndex, val)}
            basePath={`${path}.${selectedIndex}`}
            breadcrumbPath={itemBreadcrumbPath}
            onBreadcrumbChange={onBreadcrumbChange}
          />
        ) : itemSchema ? (
          renderField({
            schema: itemSchema,
            value: item,
            onChange: (val) => updateItem(selectedIndex, val),
            path: `${path}.${selectedIndex}`,
            label: itemSchema.title ?? `Item ${selectedIndex + 1}`,
            breadcrumbPath: itemBreadcrumbPath,
            onBreadcrumbChange,
          })
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="min-w-0 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium">{label}</span>
          {items.length > 0 && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
              {items.length}
            </span>
          )}
        </div>
        {schema.description && (
          <p className="break-words text-xs leading-normal text-muted-foreground">
            {schema.description}
          </p>
        )}
      </div>

      {items.length > 0 && (
        <div className="min-w-0 overflow-hidden rounded-xl border border-border/50 p-1.5">
          {items.map((item, i) => (
            <div
              key={`${path}.${i}`}
              className="group flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-2.5 hover:bg-accent hover:text-accent-foreground"
            >
              <DotsGrid className="size-3.5 shrink-0 cursor-grab text-muted-foreground/40" />
              <button
                type="button"
                onClick={() => {
                  setSelectedIndex(i);
                  onBreadcrumbChange?.([
                    ...breadcrumbPath,
                    getItemLabel(item, i),
                  ]);
                }}
                className="min-w-0 flex-1 truncate text-left text-sm"
                title={getItemLabel(item, i)}
              >
                {getItemLabel(item, i)}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Open actions for ${getItemLabel(item, i)}`}
                    className="size-6 opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <DotsHorizontal size={14} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => removeItem(i)}
                  >
                    <Trash01 size={14} />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={addItem}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/60 py-2.5 text-sm text-muted-foreground transition-colors hover:border-border hover:bg-muted/30"
      >
        <Plus size={14} />
        Add item
      </button>
    </div>
  );
}
