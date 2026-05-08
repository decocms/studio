import type { TenantConfig } from "../types";

/**
 * Deep-merge a partial patch into the current TenantConfig.
 *
 * Semantics:
 *   - field absent (undefined) → leave existing
 *   - field present (incl. null where the type allows) → set
 *   - nested objects merge field-by-field
 *   - primitives and arrays replace wholesale
 *
 * Anything in `current` that isn't shadowed by `patch` is preserved.
 */
export function deepMerge(
  current: TenantConfig | null,
  patch: Partial<TenantConfig>,
): TenantConfig {
  const base: TenantConfig = current ?? {};
  return {
    git: mergeOptional(base.git, patch.git),
    application: mergeOptional(base.application, patch.application),
  };
}

function mergeOptional<T extends object>(
  current: T | undefined,
  patch: Partial<T> | undefined,
): T | undefined {
  if (patch === undefined) return current;
  if (current === undefined) return patch as T;
  const out = { ...current } as T & Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const existing = (current as Record<string, unknown>)[k];
    if (
      isPlainObject(v) &&
      isPlainObject(existing) &&
      !Array.isArray(v) &&
      !Array.isArray(existing)
    ) {
      (out as Record<string, unknown>)[k] = mergeOptional(
        existing as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}
