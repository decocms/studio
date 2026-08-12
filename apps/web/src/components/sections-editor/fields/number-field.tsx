import { useState } from "react";
import { Input } from "@decocms/ui/components/input.tsx";
import type { FieldProps } from "./field-props";
import { FieldLabel } from "./field-label";
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
  sandbox,
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
      <FieldLabel
        htmlFor={path}
        label={label}
        description={schema.description}
        virtualMcpId={sandbox?.virtualMcpId}
      />
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
