import { useState } from "react";
import { Calendar as CalendarIcon } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Calendar } from "@decocms/ui/components/calendar.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { FieldProps } from "./field-props";
import { FieldLabel } from "./field-label";
import { RichTextField } from "./rich-text-field";

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
  const datePart = iso.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function dateInputToIso(dateValue: string): string {
  if (!dateValue) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return "";
  return `${dateValue}T00:00:00.000Z`;
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
type DatePickerInputProps = Readonly<{
  id: string;
  withTime: boolean;
  value: string;
  onChange: (iso: string) => void;
  calendarLabel?: string;
}>;

function DatePickerInput({
  id,
  withTime,
  value,
  onChange,
  calendarLabel,
}: DatePickerInputProps) {
  const [open, setOpen] = useState(false);

  const toInput = (iso: string) =>
    withTime ? isoToDateTimeInput(iso) : isoToDateInput(iso);
  const toIso = (input: string) =>
    withTime ? dateTimeInputToIso(input) : dateInputToIso(input);

  // Buffer the native input's string locally so a parent re-render (autosave,
  // decofile refetch) mid-edit doesn't reassign the controlled <input>.value and
  // yank focus/caret off the field — a Chrome quirk on date/datetime-local inputs
  // that's most visible while typing the time segment of a datetime. Same
  // local-state-with-external-resync pattern as PageHeaderInputs.
  const [inputValue, setInputValue] = useState(() => toInput(value));
  const [prevValue, setPrevValue] = useState(value);
  // Resync only on genuine external value changes (calendar pick, section/item
  // switch), never on our own edits echoing back — those round-trip to the same
  // string, so the buffer already matches and we leave the in-progress edit alone.
  if (value !== prevValue) {
    setPrevValue(value);
    const next = toInput(value);
    if (next !== inputValue) setInputValue(next);
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    onChange(toIso(e.target.value));
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
    const iso = next.toISOString();
    // Keep the local buffer and resync guard in step so the committed pick shows
    // immediately and the value echoing back doesn't re-trigger a resync.
    setInputValue(toInput(iso));
    setPrevValue(iso);
    onChange(iso);
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
        onBlur={() => setInputValue(toInput(value))}
        className="h-10 flex-1 [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:opacity-0"
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-10 w-10 shrink-0"
            aria-label={calendarLabel}
          >
            <CalendarIcon className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-auto p-0"
          align="end"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
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

export function StringField({
  schema,
  value,
  onChange,
  path,
  label,
  sandbox,
}: FieldProps) {
  const t = useT();
  const strValue = typeof value === "string" ? value : "";
  const format = schema.format;

  if (
    format === "rich-text" ||
    format === "rich-text-inline" ||
    format === "html"
  ) {
    return (
      <RichTextField
        schema={schema}
        value={value}
        onChange={onChange}
        path={path}
        label={label}
        sandbox={sandbox}
        inline={format === "rich-text-inline"}
      />
    );
  }

  if (format === "textarea" || format === "markdown") {
    return (
      <div className="space-y-2">
        <FieldLabel
          htmlFor={path}
          label={label}
          description={schema.description}
          virtualMcpId={sandbox?.virtualMcpId}
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
          virtualMcpId={sandbox?.virtualMcpId}
        />
        <DatePickerInput
          id={path}
          withTime={format === "date-time"}
          value={strValue}
          onChange={onChange}
          calendarLabel={t("sectionsEditor.stringField.openCalendar")}
        />
      </div>
    );
  }

  // "color" is the format emitted by @decocms/start's schema generator for the
  // `Color` widget alias; "color-input" is our own alias. Accept both.
  if (format === "color-input" || format === "color") {
    return (
      <div className="space-y-2">
        <FieldLabel
          htmlFor={path}
          label={label}
          description={schema.description}
          virtualMcpId={sandbox?.virtualMcpId}
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
        virtualMcpId={sandbox?.virtualMcpId}
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
