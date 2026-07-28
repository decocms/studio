import { useState } from "react";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import type { FieldProps } from "./field-props";
import { isPartialNumericInput } from "./partial-number-input";

/**
 * Number input that keeps the raw typed string in local state instead of
 * reflecting the parsed number back into the field. A controlled `type="number"`
 * bound to `Number(value)` collapses transient states like "0." to "0" on every
 * keystroke, so a leading decimal ("0.4") can never be typed left-to-right. We
 * hold the raw text, parse it for the model, and only re-adopt the external
 * value when it changes to a genuinely different number (e.g. switching variants).
 */
export function NumberField({
  schema,
  value,
  onChange,
  path,
  label,
}: FieldProps) {
  const externalStr = typeof value === "number" ? String(value) : "";
  const [raw, setRaw] = useState(externalStr);
  const [prevExternal, setPrevExternal] = useState(externalStr);

  if (externalStr !== prevExternal) {
    setPrevExternal(externalStr);
    // Don't clobber an in-progress edit ("0.") that already parses to the
    // incoming value; only adopt a truly different external number.
    const sameNumber =
      raw !== "" && externalStr !== "" && Number(raw) === Number(externalStr);
    if (!sameNumber) setRaw(externalStr);
  }

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
        type="text"
        inputMode={schema.type === "integer" ? "numeric" : "decimal"}
        value={raw}
        onChange={(e) => {
          const next = e.target.value;
          const isInteger = schema.type === "integer";
          if (next !== "" && !isPartialNumericInput(next, isInteger)) return;
          setRaw(next);
          const parsed = Number(next);
          onChange(next === "" || Number.isNaN(parsed) ? undefined : parsed);
        }}
        className="h-10"
      />
    </div>
  );
}
