import { Input } from "@deco/ui/components/input.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import type { FieldProps } from "./field-props";

export function StringField({
  schema,
  value,
  onChange,
  path,
  label,
}: FieldProps) {
  const strValue = typeof value === "string" ? value : "";
  const format = schema.format;

  if (
    format === "textarea" ||
    format === "rich-text" ||
    format === "rich-text-inline" ||
    format === "markdown"
  ) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={path}>{label}</Label>
        {schema.description && (
          <p className="text-xs text-muted-foreground">{schema.description}</p>
        )}
        <Textarea
          id={path}
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
        />
      </div>
    );
  }

  if (format === "color-input") {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={path}>{label}</Label>
        <div className="flex gap-2 items-center">
          <input
            type="color"
            value={strValue || "#000000"}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 w-8 rounded border cursor-pointer"
          />
          <Input
            id={path}
            value={strValue}
            onChange={(e) => onChange(e.target.value)}
            placeholder="#000000"
            className="flex-1"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={path}>{label}</Label>
      {schema.description && (
        <p className="text-xs text-muted-foreground">{schema.description}</p>
      )}
      <Input
        id={path}
        type={format === "url" ? "url" : "text"}
        value={strValue}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          schema.default != null ? String(schema.default) : undefined
        }
      />
    </div>
  );
}
