import { User01, Users01 } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import type { SecretInfo, SecretScopeKind } from "@/hooks/use-secrets";

/**
 * Shared secret-picker primitives used by both the env-vars and submodule-
 * credentials editors in the Sandbox card. Kept in one place so the two
 * editors can't drift (they previously carried byte-identical copies).
 */

// Secret names: letters, digits, underscore, dot, hyphen.
export const SECRET_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** Renders the selected secret (scope icon + name) inside a Select trigger. */
export function SecretPickerValue({
  field,
  secretById,
}: {
  field: { value: unknown };
  secretById: Map<string, SecretInfo>;
}) {
  const t = useT();
  const id = (field.value as string | undefined) || "";
  if (!id) return null;
  const secret = secretById.get(id);
  if (!secret) {
    return (
      <span className="text-destructive">
        {t("sandbox.envVarsField.missingSecret", { id })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 truncate">
      <ScopeIcon scope={secret.scope} />
      <span className="truncate font-mono">{secret.name}</span>
    </span>
  );
}

export function ScopeIcon({ scope }: { scope: SecretScopeKind }) {
  const Icon = scope === "user" ? User01 : Users01;
  return <Icon className="size-3 text-muted-foreground" />;
}
