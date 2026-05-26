import { useState } from "react";
import { ChevronDown, ChevronRight } from "@untitledui/icons";
import type { FieldProps } from "./field-props";
import { SchemaForm } from "../schema-form";

export function ObjectField({
  schema,
  value,
  onChange,
  path,
  label,
  breadcrumbPath,
  onBreadcrumbChange,
}: FieldProps) {
  const [open, setOpen] = useState(false);
  const objValue =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  if (!schema.properties) return null;

  const contentId = `${path}-fields`;
  const nestedBreadcrumbPath = [...(breadcrumbPath ?? []), label];

  const handleToggle = () => {
    const nextOpen = !open;
    setOpen(nextOpen);
    onBreadcrumbChange?.(
      nextOpen ? nestedBreadcrumbPath : (breadcrumbPath ?? []),
    );
  };

  return (
    <div className="min-w-0 space-y-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={handleToggle}
        className="group flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors group-hover:text-accent-foreground">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <span className="min-w-0 truncate text-sm font-medium">{label}</span>
      </button>

      {schema.description && (
        <p className="break-words pl-9 text-xs leading-normal text-muted-foreground">
          {schema.description}
        </p>
      )}

      {open && (
        <div
          id={contentId}
          className="ml-3 min-w-0 max-w-full overflow-hidden border-l border-border/80 pl-5"
        >
          <SchemaForm
            schema={schema}
            value={objValue}
            onChange={onChange}
            basePath={path}
            breadcrumbPath={nestedBreadcrumbPath}
            onBreadcrumbChange={onBreadcrumbChange}
          />
        </div>
      )}
    </div>
  );
}
