import { useState } from "react";
import { Calendar as CalendarIcon } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Calendar } from "@deco/ui/components/calendar.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import type { FieldProps } from "./field-props";

const pad = (n: number) => String(n).padStart(2, "0");

const DATE_MIN = "1900-01-01";
const DATE_MAX = "2099-12-31";
const DATETIME_MIN = "1900-01-01T00:00";
const DATETIME_MAX = "2099-12-31T23:59";

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

/**
 * Wraps a native segmented date/datetime input with a shadcn Calendar
 * popover trigger. The native input gives us auto-advancing MM/DD/YYYY
 * segments; the popover gives users a point-and-click fallback and
 * replaces the (locale-dependent, ugly) browser-native picker indicator.
 */
function DatePickerInput({
  id,
  withTime,
  value,
  onChange,
}: {
  id: string;
  withTime: boolean;
  value: string;
  onChange: (iso: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const inputValue = withTime
    ? isoToDateTimeInput(value)
    : isoToDateInput(value);
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(
      withTime
        ? dateTimeInputToIso(e.target.value)
        : dateInputToIso(e.target.value),
    );
  };

  const parsed = value ? new Date(value) : null;
  const selected = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;

  const handleCalendarSelect = (next: Date | undefined) => {
    if (!next) return;
    // Preserve the existing time when picking a date for a datetime field.
    if (withTime) {
      if (selected) {
        next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
      } else {
        next.setHours(0, 0, 0, 0);
      }
    } else {
      next.setHours(0, 0, 0, 0);
    }
    onChange(next.toISOString());
    setOpen(false);
  };

  return (
    <div className="flex gap-1">
      <Input
        id={id}
        type={withTime ? "datetime-local" : "date"}
        min={withTime ? DATETIME_MIN : DATE_MIN}
        max={withTime ? DATETIME_MAX : DATE_MAX}
        value={inputValue}
        onChange={handleInputChange}
        className="h-10 flex-1 [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:opacity-0"
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-10 w-10 shrink-0"
            aria-label="Open calendar"
          >
            <CalendarIcon className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar
            mode="single"
            selected={selected ?? undefined}
            onSelect={handleCalendarSelect}
            initialFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  );
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

  if (format === "date" || format === "date-time") {
    return (
      <div className="space-y-2">
        <FieldLabel
          htmlFor={path}
          label={label}
          description={schema.description}
        />
        <DatePickerInput
          id={path}
          withTime={format === "date-time"}
          value={strValue}
          onChange={onChange}
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
