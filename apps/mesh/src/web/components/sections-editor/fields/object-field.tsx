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
}: FieldProps) {
  const [open, setOpen] = useState(false);
  const objValue =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  if (!schema.properties) return null;

  return (
    <div className="border rounded-md">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-3 py-2 text-sm font-medium text-left hover:bg-muted/50"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {label}
      </button>
      {open && (
        <div className="px-3 pb-3">
          <SchemaForm
            schema={schema}
            value={objValue}
            onChange={onChange}
            basePath={path}
          />
        </div>
      )}
    </div>
  );
}
