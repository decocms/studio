import { useState } from "react";
import { Label } from "@decocms/ui/components/label.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { SchemaProperty } from "./resolve-schema";
import { renderField } from "./schema-form";
import {
  filterSeoSchema,
  generalSeoFieldsWithDefaultToggle,
  GENERAL_SEO_FIELD_KEYS,
} from "./seo-form-mode";
import { DEFAULT_SEO_RESOLVE_TYPE } from "./seo-block";

interface GeneralSeoFormProps {
  schema: SchemaProperty;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  /** Site/default SEO — page overrides inherit when a field is unset. */
  siteDefaultSeo?: Record<string, unknown>;
  formResetKey: number;
}

function humanize(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function fieldUsesDefault(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return value[key] === undefined;
}

/**
 * Admin's BaseSEOForm for General pages: curated fields plus per-field
 * "Use default" on page SEO (inherits site SEO when unset).
 */
export function GeneralSeoForm({
  schema,
  value,
  onChange,
  siteDefaultSeo,
  formResetKey,
}: GeneralSeoFormProps) {
  const t = useT();
  const filtered = filterSeoSchema(schema, DEFAULT_SEO_RESOLVE_TYPE);
  const properties = filtered.properties ?? {};
  const inheritKeys = generalSeoFieldsWithDefaultToggle();
  const showInherit =
    !!siteDefaultSeo && Object.keys(siteDefaultSeo).length > 0;

  const [prevResetKey, setPrevResetKey] = useState(formResetKey);
  const [inheritByField, setInheritByField] = useState<Record<string, boolean>>(
    {},
  );
  if (prevResetKey !== formResetKey) {
    setPrevResetKey(formResetKey);
    setInheritByField({});
  }

  const usesDefault = (key: string): boolean => {
    if (inheritByField[key] !== undefined) return inheritByField[key]!;
    return fieldUsesDefault(value, key);
  };

  const handleUseDefaultChange = (key: string, next: boolean) => {
    setInheritByField((prev) => ({ ...prev, [key]: next }));
    const nextValue = { ...value };
    if (next) {
      delete nextValue[key];
    } else {
      const seed = siteDefaultSeo?.[key];
      nextValue[key] =
        seed !== undefined && seed !== null
          ? seed
          : key === "type"
            ? "website"
            : "";
    }
    onChange(nextValue);
  };

  return (
    <div key={formResetKey} className="min-w-0 space-y-6">
      {GENERAL_SEO_FIELD_KEYS.map((key) => {
        const propSchema = properties[key];
        if (!propSchema) return null;

        const inherit = showInherit && inheritKeys.includes(key);
        const useDefault = inherit && usesDefault(key);
        const displayValue = useDefault
          ? (siteDefaultSeo?.[key] ?? value[key])
          : value[key];
        const label = propSchema.title ?? humanize(key);

        return (
          <div key={key} className="space-y-2">
            <div className={cn(useDefault && "pointer-events-none opacity-60")}>
              {renderField({
                schema: propSchema,
                value: displayValue,
                onChange: (fieldValue) => {
                  if (useDefault) return;
                  onChange({ ...value, [key]: fieldValue });
                },
                path: key,
                label,
                // `type` always needs a concrete value — no "None" clear option.
                required: key === "type",
                breadcrumbPath: [],
                onBreadcrumbChange: () => {},
              })}
            </div>
            {inherit && (
              <div className="flex items-center gap-2">
                <Switch
                  id={`seo-use-default-${key}`}
                  checked={useDefault}
                  onCheckedChange={(checked) =>
                    handleUseDefaultChange(key, checked)
                  }
                />
                <Label
                  htmlFor={`seo-use-default-${key}`}
                  className="text-xs font-normal text-muted-foreground"
                >
                  {t("sectionsEditor.generalSeoForm.useDefault")}
                </Label>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
