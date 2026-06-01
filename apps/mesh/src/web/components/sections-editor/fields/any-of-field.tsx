import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import type { SchemaProperty } from "../resolve-schema";
import type { FieldProps } from "./field-props";
import { SchemaForm } from "../schema-form";

function detectCurrentType(
  value: unknown,
  refs: Array<{ resolveType: string; schema?: SchemaProperty }>,
): string {
  const fallback = refs[0]?.resolveType ?? "";
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fallback;
  const obj = value as Record<string, unknown>;

  if (typeof obj.__resolveType === "string") {
    const match = refs.find((r) => r.resolveType === obj.__resolveType);
    if (match) return match.resolveType;
  }

  // Infer branch by counting matching property keys; only prefer a scored
  // branch when it actually matches something (score > 0).
  let best = fallback;
  let bestScore = -1;
  for (const ref of refs) {
    if (!ref.schema?.properties) continue;
    const score = Object.keys(ref.schema.properties).filter(
      (k) => (obj as Record<string, unknown>)[k] !== undefined,
    ).length;
    if (score > 0 && score > bestScore) {
      bestScore = score;
      best = ref.resolveType;
    }
  }
  return best;
}

export function AnyOfField({
  schema,
  value,
  onChange,
  path,
  label,
  breadcrumbPath,
  onBreadcrumbChange,
}: FieldProps) {
  // ── block-ref mode (anyOfRefs from schema resolution) ─────────────
  if (schema.anyOfRefs && schema.anyOfRefs.length > 0) {
    const refs = schema.anyOfRefs.filter((r) => r.resolveType !== "");
    if (refs.length === 0) return null;
    const currentRt = detectCurrentType(value, refs);
    const selectedRef = refs.find((r) => r.resolveType === currentRt);

    const handleRefChange = (rt: string) => {
      const targetRef = refs.find((r) => r.resolveType === rt);
      const allowed = new Set(Object.keys(targetRef?.schema?.properties ?? {}));
      const existing =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const filtered = Object.fromEntries(
        Object.entries(existing).filter(([k]) => allowed.has(k)),
      );
      onChange({ ...filtered, __resolveType: rt });
    };

    return (
      <div className="space-y-4">
        <div className="space-y-1.5">
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
            <p className="text-xs text-muted-foreground">
              {schema.description}
            </p>
          )}
        </div>
        {selectedRef?.schema?.properties && (
          <SchemaForm
            schema={selectedRef.schema}
            value={value}
            onChange={onChange}
            basePath={path}
            breadcrumbPath={breadcrumbPath}
            onBreadcrumbChange={onBreadcrumbChange}
          />
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
