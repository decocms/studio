import { labelFromResolveType } from "./section-types";
import { isLazyResolveType } from "./section-lazy";
import {
  embeddedUnionBlockId,
  isEmbeddedUnionResolveType,
  isSavedBlockResolveType,
  parseSavedBlockSchemaTitle,
  unionRefMatchesValue,
} from "./block-type-utils";
import {
  resolveSchema,
  type LiveMeta,
  type SchemaProperty,
} from "./resolve-schema";
import { V8_MULTIVARIATE_RESOLVE_TYPE } from "./variant-shape";

export type BlockRefOption = {
  resolveType: string;
  title?: string;
  description?: string;
  schema?: SchemaProperty;
  discriminatorValue?: string;
  discriminatorRequired?: boolean;
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

/** v7's flags, or on a Blocks v8 site (`v8`) its `multivariate`. */
function isMultivariateFlagResolveType(
  resolveType: string,
  v8: boolean,
): boolean {
  return (
    resolveType.includes("flags/multivariate") ||
    (v8 && resolveType === V8_MULTIVARIATE_RESOLVE_TYPE)
  );
}

function titleFromResolveType(resolveType: string): string {
  return labelFromResolveType(resolveType);
}

/**
 * Human label for a block-ref option in the selector. Saved-block references
 * carry a `#<module>@<name>` title whose `<name>` is the user-given block name
 * and may contain "/" (e.g. "Estampas / Flags"). Splitting the title/resolveType
 * on "/" truncates such names (→ " Flags"), making the option unfindable by
 * typing. Prefer the parsed block name, then the module title, then the
 * path-derived label.
 */
export function blockRefOptionLabel(ref: BlockRefOption): string {
  const savedName = ref.title
    ? parseSavedBlockSchemaTitle(ref.title)?.blockId
    : undefined;
  if (savedName) return savedName;
  if (ref.title && !ref.title.includes("/")) return ref.title;
  return (
    embeddedUnionBlockId(ref.resolveType) ??
    labelFromResolveType(ref.resolveType)
  );
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

/**
 * The value to store after editing the selected branch's form. A value with no
 * `__resolveType` shows the first branch as selected, so the edit must persist
 * that choice: deco hands bare `{ props }` to the section unresolved. Embedded
 * union variants (`…@Name`) store plain props instead.
 */
export function blockRefValueForBranch(
  next: unknown,
  activeRt: string,
): unknown {
  if (!next || typeof next !== "object" || Array.isArray(next)) return next;
  const { __resolveType, ...rest } = next as Record<string, unknown>;
  if (isEmbeddedUnionResolveType(activeRt)) return rest;
  if (
    typeof __resolveType === "string" ||
    !activeRt ||
    isSavedBlockResolveType(activeRt)
  ) {
    return next;
  }
  return { ...next, __resolveType: activeRt };
}

/**
 * A branch value of a `type`-discriminated union (`discriminatorKey`) with the
 * branch's discriminator written when it is missing and the branch requires
 * it. The form hides that field, so an edit never writes it, and deco rejects
 * a value without it (`type: required`). An optional one is left out.
 */
export function withBranchDiscriminator(
  next: unknown,
  discriminatorKey: string,
  ref: BlockRefOption | undefined,
): unknown {
  if (!next || typeof next !== "object" || Array.isArray(next)) return next;
  const discriminatorValue = ref?.discriminatorValue;
  if (discriminatorValue === undefined) return next;
  if (!ref?.discriminatorRequired) return next;
  const obj = next as Record<string, unknown>;
  // One the schema doesn't list (an older copy of it) is kept, not overwritten.
  if (obj[discriminatorKey] !== undefined) return next;
  return { ...obj, [discriminatorKey]: discriminatorValue };
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
  /** A Blocks v8 site (`useBlocksSiteEditor`). */
  v8 = false,
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
  if (moduleRt && isMultivariateFlagResolveType(moduleRt, v8)) {
    return Array.isArray(obj.variants) && obj.variants.length > 0;
  }
  return Object.keys(obj).some((k) => !k.startsWith("__") && k !== "@type");
}

/**
 * The plain object `T` of a `T | Loader<T>` block-ref (deco's `plainSchema`),
 * with its type name. `null` for other block-refs, `type`-discriminated
 * unions, and scalar widgets.
 */
function inlineDataBranch(
  schema: SchemaProperty,
): { title: string; schema: SchemaProperty } | null {
  const data = schema.plainSchema;
  if (
    schema.type !== "block-ref" ||
    schema.discriminatorKey ||
    data?.type !== "object" ||
    !data.properties
  ) {
    return null;
  }
  // deco titles a type's def with its module URL (`file:///…/ProductCard.tsx@Layout`).
  const title = data.title?.includes("://")
    ? (data.title.match(/@([A-Za-z_$][\w$]*)$/)?.[1] ?? "")
    : (data.title ?? "");
  return { title, schema: data };
}

/**
 * A `T | Loader<T>` field whose stored value is an inline `T` (no
 * `__resolveType`; `{}` when just picked), as an inline union: `T`'s form
 * beside the loader options, whose `{ __resolveType }` value renders through
 * `loaderRef`. The loader picker alone has no branch for `T`.
 */
export function inlineDataBlockRefSchema(
  schema: SchemaProperty,
  value: unknown,
): SchemaProperty | null {
  const branch = inlineDataBranch(schema);
  if (!branch || !value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.__resolveType === "string") return null;
  const keys = Object.keys(obj);
  const dataKeys = branch.schema.properties ?? {};
  if (keys.length > 0 && !keys.some((key) => key in dataKeys)) return null;
  const { plainSchema: _, ...loaderRef } = schema;
  return {
    type: "inline-union",
    title: schema.title,
    description: schema.description,
    inlineUnionBranches: [branch],
    loaderRef,
  };
}

/**
 * An empty `T[] | Loader<T[]>` field as an inline union: the list beside the
 * loader and saved-block options, whose `{ __resolveType }` value renders
 * through `loaderRef`. Without it the field offers only "Add item", so a saved
 * block can never be picked. A list with items stays a plain list, so a pick
 * never discards them.
 */
export function loaderArrayUnionSchema(
  schema: SchemaProperty,
  value: unknown,
): SchemaProperty | null {
  const { loaderRef, ...list } = schema;
  if (list.type !== "array" || !loaderRef?.anyOfRefs?.length) return null;
  if (value != null && (!Array.isArray(value) || value.length > 0)) {
    return null;
  }
  return {
    type: "inline-union",
    title: list.title,
    description: list.description,
    hidden: list.hidden,
    // The union's label already shows the description.
    inlineUnionBranches: [
      { title: "", schema: { ...list, description: undefined } },
    ],
    loaderRef,
  };
}

/**
 * The picker of a `T | Loader<T>` field with `T` as its last option. It is an
 * embedded union variant (`…@T`), so picking it stores `T`'s plain props,
 * which {@link inlineDataBlockRefSchema} then renders.
 */
export function withInlineDataOption(schema: SchemaProperty): SchemaProperty {
  const branch = inlineDataBranch(schema);
  if (!branch) return schema;
  return {
    ...schema,
    anyOfRefs: [
      ...(schema.anyOfRefs ?? []),
      {
        resolveType: `inline@${branch.title || "value"}`,
        title: branch.title,
        schema: branch.schema,
      },
    ],
  };
}
