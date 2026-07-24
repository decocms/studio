import { labelFromResolveType } from "./section-types";
import { isLazyResolveType } from "./section-lazy";
import {
  isSavedBlockResolveType,
  unionRefMatchesValue,
} from "./block-type-utils";
import {
  resolveSchema,
  type LiveMeta,
  type SchemaProperty,
} from "./resolve-schema";

export type BlockRefOption = {
  resolveType: string;
  title?: string;
  description?: string;
  schema?: SchemaProperty;
  discriminatorValue?: string;
};

/** Module resolve type used to pick JSON Schema (unwraps lazy wrappers). */
export function moduleResolveTypeFromBlockData(
  data: Record<string, unknown>,
): string | null {
  const rt = data.__resolveType;
  if (typeof rt !== "string") return null;
  if (isLazyResolveType(rt)) {
    const inner = data.section as Record<string, unknown> | undefined;
    const innerRt = inner?.__resolveType;
    return typeof innerRt === "string" ? innerRt : rt;
  }
  return rt;
}

function isMultivariateFlagResolveType(resolveType: string): boolean {
  return resolveType.includes("flags/multivariate");
}

function titleFromResolveType(resolveType: string): string {
  return labelFromResolveType(resolveType);
}

/** Ensure saved blocks and concrete module types appear in the anyOf selector. */
export function enrichBlockRefOptions(
  refs: BlockRefOption[],
  options: {
    savedBlockKey?: string;
    editorValue?: unknown;
  },
): BlockRefOption[] {
  const out = [...refs];
  const seen = new Set(out.map((r) => r.resolveType));
  const add = (resolveType: string, title?: string) => {
    if (!resolveType || seen.has(resolveType)) return;
    seen.add(resolveType);
    out.push({
      resolveType,
      title: title ?? titleFromResolveType(resolveType),
    });
  };

  if (options.savedBlockKey) {
    add(options.savedBlockKey, options.savedBlockKey);
  }

  if (
    options.editorValue &&
    typeof options.editorValue === "object" &&
    !Array.isArray(options.editorValue)
  ) {
    const moduleRt = moduleResolveTypeFromBlockData(
      options.editorValue as Record<string, unknown>,
    );
    if (moduleRt?.includes("/")) {
      add(moduleRt);
    }
  }

  return out;
}

/**
 * Pick the active anyOf branch for a block-ref field.
 * Mirrors admin: saved-block pointers match by block id first; module paths
 * must not fall through to property scoring (Theme `variants` ≠ multivariate).
 */
export function detectBlockRefType(
  value: unknown,
  refs: BlockRefOption[],
  savedBlockKey?: string,
): string {
  const fallback = refs[0]?.resolveType ?? "";

  if (savedBlockKey) {
    return savedBlockKey;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }

  const obj = value as Record<string, unknown>;

  const rt = obj.__resolveType;
  if (typeof rt === "string") {
    if (isSavedBlockResolveType(rt)) {
      const savedRef = refs.find((r) => r.resolveType === rt);
      if (savedRef) return savedRef.resolveType;
      return rt;
    }

    const unionMatch = refs.find((r) =>
      unionRefMatchesValue(r.resolveType, rt),
    );
    if (unionMatch) return unionMatch.resolveType;

    const exact = refs.find((r) => r.resolveType === rt);
    if (exact) return exact.resolveType;

    if (rt.includes("/")) return rt;
  }

  const typeVal = typeof obj.type === "string" ? obj.type : undefined;
  if (typeVal) {
    const byDiscriminator = refs.find(
      (r) =>
        r.discriminatorValue === typeVal ||
        r.resolveType === typeVal ||
        unionRefMatchesValue(r.resolveType, typeVal),
    );
    if (byDiscriminator) return byDiscriminator.resolveType;
  }

  let best = fallback;
  let bestScore = -1;
  for (const ref of refs) {
    if (!ref.schema?.properties) continue;
    const keys = Object.keys(ref.schema.properties).filter(
      (k) =>
        !k.startsWith("__") && k !== "@type" && k !== "action" && k !== "alt",
    );
    const score = keys.filter((k) => obj[k] !== undefined).length;
    if (score > 0 && score > bestScore) {
      bestScore = score;
      best = ref.resolveType;
    }
  }
  if (bestScore > 0) return best;

  return best;
}

/** Resolve nested form schema from live meta (admin uses getSchemaRefForResolveType). */
export function resolveNestedBlockRefSchema(
  editorValue: unknown,
  meta: LiveMeta | undefined,
  fallback?: SchemaProperty | null,
): SchemaProperty | null {
  if (
    !editorValue ||
    typeof editorValue !== "object" ||
    Array.isArray(editorValue)
  ) {
    return fallback ?? null;
  }
  const moduleRt = moduleResolveTypeFromBlockData(
    editorValue as Record<string, unknown>,
  );
  if (!moduleRt) return fallback ?? null;

  if (!meta) {
    return moduleRt.includes("/") ? null : (fallback ?? null);
  }

  const resolved = resolveSchema(moduleRt, meta);
  if (resolved) return resolved;

  if (moduleRt.includes("/")) return null;

  return fallback ?? null;
}

export function schemaWithoutDiscriminator(
  schema: SchemaProperty | null | undefined,
  discriminatorKey?: string,
): SchemaProperty | null {
  if (!schema?.properties || !discriminatorKey) return schema ?? null;
  if (!(discriminatorKey in schema.properties)) return schema;
  const properties = { ...schema.properties };
  delete properties[discriminatorKey];
  return { ...schema, properties };
}

/**
 * When a block-ref value is a Lazy section wrapper
 * (`{ __resolveType: ".../Lazy.tsx", section: { <real section> } }`), return the
 * inner section so the form can bind against the real props. The schema is
 * already resolved from the inner (via moduleResolveTypeFromBlockData), so
 * without unwrapping the value too every field would render empty. Returns null
 * when `value` is not a Lazy wrapper.
 */
export function lazyWrappedInner(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.__resolveType !== "string" ||
    !isLazyResolveType(obj.__resolveType)
  ) {
    return null;
  }
  const section = obj.section;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return null;
  }
  return section as Record<string, unknown>;
}

export function blockRefLoaderConfigHasData(
  editorValue: unknown,
  savedBlockKey?: string,
): boolean {
  if (savedBlockKey) return true;
  if (
    !editorValue ||
    typeof editorValue !== "object" ||
    Array.isArray(editorValue)
  ) {
    return false;
  }
  const obj = editorValue as Record<string, unknown>;
  const moduleRt = moduleResolveTypeFromBlockData(obj);
  if (moduleRt && isMultivariateFlagResolveType(moduleRt)) {
    return Array.isArray(obj.variants) && obj.variants.length > 0;
  }
  return Object.keys(obj).some((k) => !k.startsWith("__") && k !== "@type");
}
