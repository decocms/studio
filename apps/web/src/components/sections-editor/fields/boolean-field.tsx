import { Switch } from "@decocms/ui/components/switch.tsx";
import type { FieldProps } from "./field-props";
import { FieldLabel } from "./field-label";

export function BooleanField({
  value,
  onChange,
  path,
  label,
  schema,
  sandbox,
}: FieldProps) {
  const checked = typeof value === "boolean" ? value : false;

  return (
    <div className="flex items-center justify-between gap-3">
      <FieldLabel
        htmlFor={path}
        label={label}
        description={schema.description}
        virtualMcpId={sandbox?.virtualMcpId}
      />
      <Switch
        id={path}
        checked={checked}
        onCheckedChange={(v) => onChange(v)}
      />
    </div>
  );
}
