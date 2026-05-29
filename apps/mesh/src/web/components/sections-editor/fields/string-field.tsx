import { Input } from "@deco/ui/components/input.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import type { FieldProps } from "./field-props";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Native <input type="date"> / <input type="datetime-local"> give us the
 * segmented MM/DD/YYYY auto-advance UX users expect from a date picker.
 * Deco persists ISO 8601 strings, so we convert at the edges.
 */
function isoToDateInput(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dateInputToIso(dateValue: string): string {
  if (!dateValue) return "";
  // Interpret as local midnight so the date the user picked is what gets stored.
  const d = new Date(`${dateValue}T00:00:00`);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function isoToDateTimeInput(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dateTimeInputToIso(localValue: string): string {
  if (!localValue) return "";
  const d = new Date(localValue);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

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

  if (format === "date") {
    return (
      <div className="space-y-2">
        <FieldLabel
          htmlFor={path}
          label={label}
          description={schema.description}
        />
        <Input
          id={path}
          type="date"
          value={isoToDateInput(strValue)}
          onChange={(e) => onChange(dateInputToIso(e.target.value))}
          className="h-10"
        />
      </div>
    );
  }

  if (format === "date-time") {
    return (
      <div className="space-y-2">
        <FieldLabel
          htmlFor={path}
          label={label}
          description={schema.description}
        />
        <Input
          id={path}
          type="datetime-local"
          value={isoToDateTimeInput(strValue)}
          onChange={(e) => onChange(dateTimeInputToIso(e.target.value))}
          className="h-10"
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
