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
    <div className="space-y-2">
      <div className="space-y-0.5">
        <Label htmlFor={path}>{label}</Label>
        {schema.description && (
          <p className="text-xs leading-normal text-muted-foreground">
            {schema.description}
          </p>
        )}
      </div>
      {strValue && (
        <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/30">
          <img
            src={strValue}
            alt={label}
            className="max-h-32 w-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).parentElement!.style.display =
                "none";
            }}
          />
        </div>
      )}
      <Input
        id={path}
        type="url"
        value={strValue}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://..."
        className="h-10"
      />
    </div>
  );
}
