import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import type { FieldProps } from "./field-props";

const DEFAULT_SECRET_RESOLVE_TYPE = "website/loaders/secret.ts";

export function isSecretBlock(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const resolveType = (value as Record<string, unknown>).__resolveType;
  return (
    typeof resolveType === "string" &&
    (resolveType.endsWith("/secret.ts") ||
      resolveType.includes("loaders/secret"))
  );
}

function emptySecretBlock(): Record<string, unknown> {
  return {
    __resolveType: DEFAULT_SECRET_RESOLVE_TYPE,
    name: "",
    encrypted: "",
  };
}

/**
 * Deco stores API secrets as `website/loaders/secret.ts` blocks (`name` + `encrypted`).
 * JSON Schema often marks these as `format: password` or `format: string` without `type`.
 */
export function SecretField({
  schema,
  value,
  onChange,
  label,
  path,
}: FieldProps) {
  const block = isSecretBlock(value)
    ? (value as Record<string, unknown>)
    : emptySecretBlock();
  const name = typeof block.name === "string" ? block.name : "";
  const hasStoredSecret =
    typeof block.encrypted === "string" && block.encrypted;

  return (
    <div className="space-y-2">
      <Label htmlFor={`${path}-name`} className="text-sm font-medium">
        {label}
      </Label>
      {schema.description && (
        <p className="text-xs text-muted-foreground">{schema.description}</p>
      )}
      <Input
        id={`${path}-name`}
        value={name}
        placeholder="Secret name"
        onChange={(e) => onChange({ ...block, name: e.target.value })}
        className="h-10"
      />
      <Input
        id={`${path}-value`}
        type="password"
        placeholder={
          hasStoredSecret ? "Leave blank to keep current value" : "Secret value"
        }
        onChange={(e) => {
          const next = e.target.value;
          if (!next) {
            onChange(block);
            return;
          }
          onChange({ ...block, value: next });
        }}
        className="h-10"
      />
      {hasStoredSecret && (
        <p className="text-xs text-muted-foreground">
          A secret value is stored.
        </p>
      )}
    </div>
  );
}
