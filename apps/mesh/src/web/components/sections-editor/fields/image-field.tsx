import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import type { FieldProps } from "./field-props";

export function ImageField({
  schema,
  value,
  onChange,
  path,
  label,
}: FieldProps) {
  const strValue = typeof value === "string" ? value : "";

  return (
    <div className="space-y-1.5">
      <Label htmlFor={path}>{label}</Label>
      {schema.description && (
        <p className="text-xs text-muted-foreground">{schema.description}</p>
      )}
      <div className="flex gap-2 items-start">
        <Input
          id={path}
          type="url"
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://..."
          className="flex-1"
        />
        {strValue && (
          <img
            src={strValue}
            alt={label}
            className="h-10 w-10 rounded border object-cover shrink-0"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        )}
      </div>
    </div>
  );
}
