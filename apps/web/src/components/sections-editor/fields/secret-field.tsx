import { useT } from "@/i18n/use-t.ts";
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

function omitPendingSecretValue(
  block: Record<string, unknown>,
): Record<string, unknown> {
  const { value: _omit, ...rest } = block;
  return rest;
}

/**
 * Deco stores API secrets as `website/loaders/secret.ts` blocks (`name` + `encrypted`).
 * The editor may emit a transient `value` when the user enters a new secret; the deco
 * runtime encrypts it on save. JSON Schema often marks these as `format: password`.
 */
export function SecretField({
  schema,
  value,
  onChange,
  label,
  path,
}: FieldProps) {
  const t = useT();

  if (typeof value === "string" || (value == null && !isSecretBlock(value))) {
    const stringValue = typeof value === "string" ? value : "";
    return (
      <div className="space-y-2">
        <Label htmlFor={path} className="text-sm font-medium">
          {label}
        </Label>
        {schema.description && (
          <p className="text-xs text-muted-foreground">{schema.description}</p>
        )}
        <Input
          id={path}
          type="password"
          value={stringValue}
          autoComplete="new-password"
          autoCorrect="off"
          spellCheck={false}
          placeholder={t("sectionsEditor.secretField.secretValuePlaceholder")}
          onChange={(e) => onChange(e.target.value)}
          className="h-10"
        />
      </div>
    );
  }

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
        placeholder={t("sectionsEditor.secretField.secretNamePlaceholder")}
        onChange={(e) => onChange({ ...block, name: e.target.value })}
        className="h-10"
      />
      <Input
        id={`${path}-value`}
        type="password"
        autoComplete="new-password"
        autoCorrect="off"
        spellCheck={false}
        placeholder={
          hasStoredSecret
            ? t("sectionsEditor.secretField.leaveBlankPlaceholder")
            : t("sectionsEditor.secretField.secretValuePlaceholder")
        }
        onChange={(e) => {
          const next = e.target.value;
          if (!next) {
            onChange(hasStoredSecret ? omitPendingSecretValue(block) : block);
            return;
          }
          onChange({ ...block, value: next });
        }}
        className="h-10"
      />
      {hasStoredSecret && (
        <p className="text-xs text-muted-foreground">
          {t("sectionsEditor.secretField.storedSecretMessage")}
        </p>
      )}
    </div>
  );
}
