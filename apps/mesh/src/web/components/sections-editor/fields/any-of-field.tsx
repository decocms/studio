import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { useState } from "react";
import type { FieldProps } from "./field-props";
import { SchemaForm } from "../schema-form";

export function AnyOfField({
  schema,
  value,
  onChange,
  path,
  label,
}: FieldProps) {
  const variants = schema.anyOf ?? [];

  // Try to figure out which variant is active based on current value
  const detectVariantIndex = (): number => {
    if (value == null) return 0;

    // If value has __resolveType, match on that
    if (typeof value === "object" && !Array.isArray(value)) {
      const rt = (value as Record<string, unknown>).__resolveType;
      if (typeof rt === "string") {
        const idx = variants.findIndex(
          (v) => v.const === rt || v.enum?.[0] === rt,
        );
        if (idx >= 0) return idx;
      }
    }

    // Match on const value
    const idx = variants.findIndex((v) => v.const === value);
    if (idx >= 0) return idx;

    return 0;
  };

  const [selectedIdx, setSelectedIdx] = useState(detectVariantIndex);
  const activeVariant = variants[selectedIdx];

  const handleVariantChange = (idx: string) => {
    const i = Number(idx);
    setSelectedIdx(i);
    const v = variants[i];
    // Reset to default for this variant
    if (v?.const !== undefined) {
      onChange(v.const);
    } else if (v?.default !== undefined) {
      onChange(v.default);
    } else if (v?.type === "object") {
      onChange({});
    } else {
      onChange(undefined);
    }
  };

  if (variants.length === 0) return null;

  // Simple enum-like anyOf (all variants are const strings)
  const allConst = variants.every((v) => v.const !== undefined);
  if (allConst) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={path}>{label}</Label>
        <Select value={String(selectedIdx)} onValueChange={handleVariantChange}>
          <SelectTrigger>
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            {variants.map((v, i) => (
              <SelectItem key={i} value={String(i)}>
                {v.title ?? String(v.const)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={path}>{label}</Label>
      {variants.length > 1 && (
        <Select value={String(selectedIdx)} onValueChange={handleVariantChange}>
          <SelectTrigger>
            <SelectValue placeholder="Select type..." />
          </SelectTrigger>
          <SelectContent>
            {variants.map((v, i) => (
              <SelectItem key={i} value={String(i)}>
                {v.title ?? `Option ${i + 1}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {activeVariant?.properties && (
        <div className="border rounded-md p-3">
          <SchemaForm
            schema={activeVariant}
            value={
              typeof value === "object" && value !== null
                ? (value as Record<string, unknown>)
                : {}
            }
            onChange={onChange}
            basePath={`${path}.$${selectedIdx}`}
          />
        </div>
      )}
    </div>
  );
}
