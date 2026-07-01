import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import type { SchemaProperty } from "../resolve-schema";
import { SchemaForm } from "../schema-form";
import type { FieldProps } from "./field-props";
import { inferInlineUnionIndex } from "./inline-union-value";
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
  return { ...schema, properties };
}

/**
 * Renders an inline object union ("A or B" plain-data union, e.g.
 * `Location | Map`) as a branch selector. The editor picks a branch; the value
 * is stored as a plain object (seeded with the branch's const discriminators,
 * if any) — never a `__resolveType`.
 */
export function InlineUnionField(props: FieldProps) {
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

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={path}>{label}</Label>
        <Select value={String(activeIndex)} onValueChange={handleBranchChange}>
          <SelectTrigger id={path}>
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            {branches.map((branch, index) => (
              <SelectItem key={branch.title} value={String(index)}>
                {branch.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {schema.description && (
          <p className="text-xs text-muted-foreground">{schema.description}</p>
        )}
      </div>

      {activeBranch &&
        (isLocationShape(activeBranch.schema?.properties) ? (
          <LocationField
            {...props}
            schema={activeBranch.schema as SchemaProperty}
          />
        ) : formSchema ? (
          <SchemaForm
            schema={formSchema}
            value={value}
            onChange={onChange}
            basePath={path}
            breadcrumbPath={props.breadcrumbPath}
            onBreadcrumbChange={props.onBreadcrumbChange}
            meta={props.meta}
            decofile={props.decofile}
            onSaveReferencedBlock={props.onSaveReferencedBlock}
            sandbox={props.sandbox}
          />
        ) : null)}
    </div>
  );
}
