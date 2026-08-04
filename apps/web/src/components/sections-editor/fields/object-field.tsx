import { useState } from "react";
import { ChevronDown, ChevronRight } from "@untitledui/icons";
import { FieldDescriptionTooltip } from "./field-label";
import type { FieldProps } from "./field-props";
import { isBreadcrumbInsideObject } from "../schema-form-breadcrumb";
import { SchemaForm } from "../schema-form";

export function ObjectField({
  schema,
  value,
  onChange,
  path,
  label,
  breadcrumbPath = [],
  onBreadcrumbChange,
  meta,
  decofile,
  onSaveReferencedBlock,
  previewBaseUrl,
  onAddSectionItem,
  onRequestAddSection,
  sandbox,
}: FieldProps) {
  const [open, setOpen] = useState(false);
  const objValue =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  if (!schema.properties) return null;

  const fieldKey = path.split(".").pop() ?? path;
  const breadcrumbInside = isBreadcrumbInsideObject(
    fieldKey,
    label,
    schema,
    objValue,
    breadcrumbPath,
    decofile,
  );
  const isOpen = open || breadcrumbInside;
  const contentId = `${path}-fields`;

  return (
    <div className="min-w-0 space-y-2">
      <div className="group flex w-full min-w-0 items-center gap-1 rounded-md py-1.5 pr-2 transition-colors hover:bg-accent hover:text-accent-foreground">
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={contentId}
          onClick={() => setOpen((prev) => !prev)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors group-hover:text-accent-foreground">
            {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
          <span className="min-w-0 truncate text-sm font-medium">{label}</span>
        </button>
        {schema.description && (
          <FieldDescriptionTooltip description={schema.description} />
        )}
      </div>

      {isOpen && (
        <div
          id={contentId}
          className="ml-3 min-w-0 max-w-full overflow-hidden border-l border-border/80 pl-5"
        >
          <SchemaForm
            schema={schema}
            value={objValue}
            onChange={onChange}
            basePath={path}
            breadcrumbPath={breadcrumbPath}
            onBreadcrumbChange={onBreadcrumbChange}
            meta={meta}
            decofile={decofile}
            onSaveReferencedBlock={onSaveReferencedBlock}
            previewBaseUrl={previewBaseUrl}
            onAddSectionItem={onAddSectionItem}
            onRequestAddSection={onRequestAddSection}
            sandbox={sandbox}
          />
        </div>
      )}
    </div>
  );
}
