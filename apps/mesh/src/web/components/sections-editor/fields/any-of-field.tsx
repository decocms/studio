import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import type { FieldProps } from "./field-props";

export function AnyOfField({
  schema,
  value,
  onChange,
  path,
  label,
}: FieldProps) {
  // ── block-ref mode (anyOfRefs from schema resolution) ─────────────
  if (schema.anyOfRefs && schema.anyOfRefs.length > 0) {
    const refs = schema.anyOfRefs;
    const currentRt =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).__resolveType === "string"
        ? ((value as Record<string, unknown>).__resolveType as string)
        : (refs[0]?.resolveType ?? "");

    const handleRefChange = (rt: string) => {
      onChange({ __resolveType: rt });
    };

    return (
      <div className="space-y-1.5">
        <Label htmlFor={path}>{label}</Label>
        <Select value={currentRt} onValueChange={handleRefChange}>
          <SelectTrigger>
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            {refs.map((ref) => (
              <SelectItem key={ref.resolveType} value={ref.resolveType}>
                {ref.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {schema.description && (
          <p className="text-xs text-muted-foreground">{schema.description}</p>
        )}
      </div>
    );
  }

  // ── Fallback: render a basic text input for unresolved anyOf fields ──
  return (
    <div className="space-y-1.5">
      <Label htmlFor={path}>{label}</Label>
      <input
        id={path}
        type="text"
        value={value != null ? String(value) : ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
        placeholder={schema.description ?? ""}
      />
      {schema.description && (
        <p className="text-xs text-muted-foreground">{schema.description}</p>
      )}
    </div>
  );
}
