/**
 * Compact form for editing MCP tool input properties. Renders fields
 * from an MCP tool's `inputSchema.properties` using the same type
 * mapping as the tool detail panel (string/number → Input, object/array
 * → Textarea, boolean → Select).
 *
 * Designed to fit inside the add-tile drawer inline expansion.
 */

import { Input } from "@deco/ui/components/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { useT } from "@/web/i18n/use-t.ts";

/** One entry of an MCP tool's `inputSchema.properties`. */
export interface ToolInputProperty {
  type: string;
  description?: string;
}

interface ToolInputFormProps {
  /** `inputSchema.properties` from the MCP tool definition. */
  properties: Record<string, ToolInputProperty>;
  /** Names of required fields (`inputSchema.required`). */
  required?: string[];
  /** Current field values. */
  values: Record<string, unknown>;
  /** Called when a field changes. */
  onChange: (key: string, value: unknown) => void;
}

export function ToolInputForm({
  properties,
  required,
  values,
  onChange,
}: ToolInputFormProps) {
  const requiredSet = new Set(required ?? []);

  return (
    <div className="flex flex-col gap-2">
      {Object.entries(properties).map(([key, prop]) => (
        <div key={key} className="flex flex-col gap-0.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium leading-none flex items-center gap-1">
              {key}
              {requiredSet.has(key) && (
                <span className="text-destructive text-[10px]">*</span>
              )}
            </label>
            <span className="text-[10px] text-muted-foreground font-mono">
              {prop.type}
            </span>
          </div>
          {prop.description && (
            <p className="text-[10px] text-muted-foreground leading-snug">
              {prop.description}
            </p>
          )}
          <FieldInput
            type={prop.type}
            fieldKey={key}
            value={values[key]}
            onChange={(v) => onChange(key, v)}
          />
        </div>
      ))}
    </div>
  );
}

function FieldInput({
  type,
  fieldKey,
  value,
  onChange,
}: {
  type: string;
  fieldKey: string;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const t = useT();
  if (type === "object" || type === "array") {
    return (
      <Textarea
        className="font-mono text-xs h-16"
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("common.toolInputForm.jsonPlaceholder", { fieldKey })}
        rows={2}
      />
    );
  }
  if (type === "boolean") {
    return (
      <Select
        value={value != null ? String(value) : ""}
        onValueChange={(v) => onChange(v === "true")}
      >
        <SelectTrigger className="h-7 text-xs">
          <SelectValue
            placeholder={t("common.toolInputForm.selectPlaceholder")}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">{t("common.toolInputForm.true")}</SelectItem>
          <SelectItem value="false">
            {t("common.toolInputForm.false")}
          </SelectItem>
        </SelectContent>
      </Select>
    );
  }
  return (
    <Input
      className="h-7 text-xs"
      value={(value as string) ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={t("common.toolInputForm.enterPlaceholder", { fieldKey })}
    />
  );
}
