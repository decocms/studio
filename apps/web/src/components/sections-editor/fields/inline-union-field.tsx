import { useState } from "react";
import { useT } from "@/i18n/use-t.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import type { SchemaProperty } from "../resolve-schema";
import { SchemaForm } from "../schema-form";
import { FieldLabel } from "./field-label";
import type { FieldProps } from "./field-props";
import {
  inferInlineUnionIndex,
  preservedOtherBranchFields,
} from "./inline-union-value";
import { LocationField } from "./location-field";
import { isLocationShape } from "./location/location-value";

type Branch = NonNullable<SchemaProperty["inlineUnionBranches"]>[number];

/** Drop const discriminator fields from a branch schema — they're implied by
 * the selected branch and shouldn't render as editable inputs. */
function branchFormSchema(branch: Branch): SchemaProperty | null {
  const schema = branch.schema;
  if (!schema?.properties) return null;
  const discKeys = new Set(Object.keys(branch.discriminators ?? {}));
  if (discKeys.size === 0) return schema;
  const properties: Record<string, SchemaProperty> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!discKeys.has(key)) properties[key] = prop;
  }
  // A branch whose only fields are const discriminators (e.g. a userSegment
  // option with no extra config) has nothing to edit — render just the selector
  // instead of an empty "no fields" form.
  if (Object.keys(properties).length === 0) return null;
  return { ...schema, properties };
}

/**
 * Renders an inline object union ("A or B" plain-data union, e.g.
 * `Location | Map`) as a branch selector. The editor picks a branch; the value
 * is stored as a plain object (seeded with the branch's const discriminators,
 * if any) — never a `__resolveType`.
 */
export function InlineUnionField(props: FieldProps) {
  const t = useT();
  const { schema, value, onChange, path, label } = props;
  const branches = schema.inlineUnionBranches ?? [];

  const inferred = inferInlineUnionIndex(
    value,
    branches.map((b) => ({
      discriminators: b.discriminators,
      propertyKeys: Object.keys(b.schema?.properties ?? {}),
    })),
  );
  const [selected, setSelected] = useState(inferred);
  const [prevInferred, setPrevInferred] = useState(inferred);
  if (prevInferred !== inferred) {
    setPrevInferred(inferred);
    setSelected(inferred);
  }
  const activeIndex = Math.min(selected, branches.length - 1);
  const activeBranch = branches[activeIndex];

  const handleBranchChange = (next: string) => {
    const index = Number(next);
    setSelected(index);
    // Reset to a fresh value for the chosen branch, seeded with its const
    // discriminators (e.g. { name: "max-age" }).
    onChange({ ...(branches[index]?.discriminators ?? {}) });
  };

  if (branches.length === 0) return null;

  const formSchema = activeBranch ? branchFormSchema(activeBranch) : null;
  // Keep any constraints from the other branch that a legacy combined entry may
  // carry, so editing the visible branch doesn't drop the hidden side.
  const preserved = preservedOtherBranchFields(
    value,
    Object.keys(activeBranch?.schema?.properties ?? {}),
  );

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {label && (
          <FieldLabel
            htmlFor={path}
            label={label}
            description={schema.description}
            virtualMcpId={props.sandbox?.virtualMcpId}
          />
        )}
        <Select value={String(activeIndex)} onValueChange={handleBranchChange}>
          <SelectTrigger id={path}>
            <SelectValue
              placeholder={t(
                "sectionsEditor.inlineUnionField.selectPlaceholder",
              )}
            />
          </SelectTrigger>
          <SelectContent>
            {branches.map((branch, index) => (
              <SelectItem key={branch.title} value={String(index)}>
                {branch.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {activeBranch &&
        (isLocationShape(activeBranch.schema?.properties) ? (
          <LocationField
            {...props}
            schema={activeBranch.schema as SchemaProperty}
            onChange={(loc) =>
              // Preserve the other branch's fields and re-assert the active
              // branch's const discriminators so the branch tag survives edits.
              onChange({
                ...preserved,
                ...(loc as Record<string, unknown>),
                ...(activeBranch.discriminators ?? {}),
              })
            }
          />
        ) : formSchema ? (
          <SchemaForm
            schema={formSchema}
            value={value}
            // Const discriminators are stripped from the rendered form, so
            // re-apply them on every update to keep the branch tag.
            onChange={(next) =>
              onChange({
                ...(next as Record<string, unknown>),
                ...(activeBranch.discriminators ?? {}),
              })
            }
            basePath={path}
            breadcrumbPath={props.breadcrumbPath}
            onBreadcrumbChange={props.onBreadcrumbChange}
            meta={props.meta}
            decofile={props.decofile}
            onSaveReferencedBlock={props.onSaveReferencedBlock}
            sandbox={props.sandbox}
            previewBaseUrl={props.previewBaseUrl}
            onAddSectionItem={props.onAddSectionItem}
            onRequestAddSection={props.onRequestAddSection}
          />
        ) : null)}
    </div>
  );
}
