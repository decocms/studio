import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import type { FieldProps } from "./field-props";

export function NumberField({
  schema,
  value,
  onChange,
  path,
  label,
}: FieldProps) {
  const numValue = typeof value === "number" ? value : "";

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <Label htmlFor={path}>{label}</Label>
        {schema.description && (
          <p className="text-xs leading-normal text-muted-foreground">
            {schema.description}
          </p>
        )}
      </div>
      <Input
        id={path}
        type="number"
        value={numValue}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? undefined : Number(v));
        }}
        className="h-10"
      />
    </div>
  );
}
