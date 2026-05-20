import type { TenantConfig } from "../types";
import type { ConfigPatch } from "./types";

/**
 * Deep-merge a partial patch into the current TenantConfig.
 *
 * Semantics:
 *   - field absent (undefined) → leave existing
 *   - field present (incl. null where the type allows) → set
 *   - nested objects merge field-by-field
 *   - primitives and arrays replace wholesale
 *   - env is per-key: string → upsert, null → delete that key only
 *
 * Anything in `current` that isn't shadowed by `patch` is preserved.
 */
export function deepMerge(
  current: TenantConfig | null,
  patch: ConfigPatch,
): TenantConfig {
  const base: TenantConfig = current ?? {};
  return {
    git: mergeOptional(base.git, patch.git),
    application: mergeOptional(base.application, patch.application),
    env: mergeEnv(base.env, patch.env),
  };
}

function mergeEnv(
  current: Readonly<Record<string, string>> | undefined,
  patch: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
  if (patch === undefined) return current ? { ...current } : undefined;
  const out: Record<string, string> = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (typeof v === "string") out[k] = v;
    // any other type is rejected downstream by validateTenantConfig
    else (out as Record<string, unknown>)[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
