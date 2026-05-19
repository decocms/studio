import { Switch } from "@deco/ui/components/switch.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import type { FieldProps } from "./field-props";

export function BooleanField({
  value,
  onChange,
  path,
  label,
  schema,
}: FieldProps) {
  const checked = typeof value === "boolean" ? value : false;

  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <div>
        <Label htmlFor={path}>{label}</Label>
        {schema.description && (
          <p className="text-xs text-muted-foreground">{schema.description}</p>
        )}
      </div>
      <Switch
        id={path}
        checked={checked}
        onCheckedChange={(v) => onChange(v)}
      />
    </div>
  );
}
