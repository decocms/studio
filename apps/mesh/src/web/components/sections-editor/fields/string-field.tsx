import { Input } from "@deco/ui/components/input.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import type { FieldProps } from "./field-props";

function FieldLabel({
  htmlFor,
  label,
  description,
}: {
  htmlFor: string;
  label: string;
  description?: string;
}) {
  return (
    <div className="space-y-0.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {description && (
        <p className="text-xs leading-normal text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
}

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
      <div className="space-y-2">
        <FieldLabel
          htmlFor={path}
          label={label}
          description={schema.description}
        />
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
      <div className="space-y-2">
        <FieldLabel
          htmlFor={path}
          label={label}
          description={schema.description}
        />
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={strValue || "#000000"}
            onChange={(e) => onChange(e.target.value)}
            className="h-10 w-10 cursor-pointer rounded-lg border border-border bg-background p-1"
          />
          <Input
            id={path}
            value={strValue}
            onChange={(e) => onChange(e.target.value)}
            placeholder="#000000"
            className="h-10 flex-1"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor={path}
        label={label}
        description={schema.description}
      />
      <Input
        id={path}
        type={format === "url" ? "url" : "text"}
        value={strValue}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          schema.default != null ? String(schema.default) : undefined
        }
        className="h-10"
      />
    </div>
  );
}
