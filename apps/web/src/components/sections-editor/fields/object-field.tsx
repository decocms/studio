import { useState } from "react";
import { ChevronDown, ChevronRight } from "@untitledui/icons";
import {
  FieldDescriptionTooltip,
  useFieldDescriptionTooltips,
} from "./field-label";
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
  focused,
  meta,
  decofile,
  onSaveReferencedBlock,
  previewBaseUrl,
  onAddSectionItem,
  onRequestAddSection,
  sandbox,
}: FieldProps) {
  const [open, setOpen] = useState(false);
  const tooltipsEnabled = useFieldDescriptionTooltips(sandbox?.virtualMcpId);
  const objValue =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  if (!schema.properties) return null;

  // Single source for the nested form so the focused (flat) and collapsible
  // branches can't drift apart when a prop is added.
  const form = (
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
  );

  // Drilled into via the breadcrumb: render the fields flat, without this
  // object's collapsible header or indentation. The breadcrumb already shows
  // where we are, so stacking wrapper headers (e.g. Props > ShelfProps >
  // CardLayout) just buries the item's own fields.
  if (focused) return form;

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
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={contentId}
        onClick={() => setOpen((prev) => !prev)}
        className="group flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors group-hover:text-accent-foreground">
          {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <FieldDescriptionTooltip
          description={schema.description}
          virtualMcpId={sandbox?.virtualMcpId}
        >
          <span className="min-w-0 truncate text-sm font-medium">{label}</span>
        </FieldDescriptionTooltip>
      </button>

      {!tooltipsEnabled && schema.description && (
        <p className="break-words pl-9 text-xs leading-normal text-muted-foreground">
          {schema.description}
        </p>
      )}

      {isOpen && (
        <div
          id={contentId}
          className="ml-3 min-w-0 max-w-full overflow-hidden border-l border-border/80 pl-5"
        >
          {form}
        </div>
      )}
    </div>
  );
}
