import {
  isManifestAppResolveType,
  parseSavedBlockSchemaTitle,
} from "./block-type-utils";
import {
  PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
  labelFromResolveType,
} from "./section-types";

/**
 * Schema resolution for /live/_meta JSON Schemas.
 *
 * Mirrors the admin-mcp `buildProperty` / `collectProps` pattern:
 * resolves $ref, merges allOf/anyOf/oneOf, detects enum-from-const
 * patterns, and identifies block-ref (loader selector) fields.
 */

export interface SchemaProperty {
  type: string;
  title?: string;
  description?: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
  properties?: Record<string, SchemaProperty>;
  items?: SchemaProperty;
  titleBy?: string;
  /** Mustache template for array-item thumbnails (from schema `@image`) */
  image?: string;
  /** Loader path for dynamic-options fields (from schema `@options`) */
  options?: string;
  /**
   * Present on "block-ref" fields — a union of compatible block types
   * (loaders, sections, etc.). The UI renders a selector instead of
   * a flat form.
   */
  anyOfRefs?: Array<{
    resolveType: string;
    title: string;
    description?: string;
    schema?: SchemaProperty;
    /** Value of the union discriminator field (e.g. `image-card`). */
    discriminatorValue?: string;
  }>;
  /** Property used to pick the active union branch (e.g. `type`). */
  discriminatorKey?: string;
  /**
   * Branches of an inline object union ("A or B" plain-data union, e.g.
   * `Location | Map`), present when `type === "inline-union"`. Unlike block-ref
   * unions these carry no `__resolveType`/`$ref` — the editor picks a branch and
   * persists a plain object. `discriminators` holds any const-valued fields that
   * identify the branch (e.g. `{ name: "max-age" }`).
   */
  inlineUnionBranches?: Array<{
    title: string;
    schema?: SchemaProperty;
    discriminators?: Record<string, string | number | boolean>;
  }>;
  /** When true, the field should not be rendered in the form. */
  hidden?: boolean;
  /**
   * For block-ref fields with loader branches: the resolved schema of the
   * non-loader branch (e.g. the plain `{ type: "string", format: "image-uri" }`
   * for an ImageWidget union). Used by multivariate field rendering to avoid
   * circular detection when the variant value schema points back to the same
   * anyOf union.
   */
  plainSchema?: SchemaProperty;
}

export type SchemaAnyOfRef = NonNullable<SchemaProperty["anyOfRefs"]>[number];

export interface LiveMeta {
  manifest: {
    blocks: Record<
      string,
      Record<string, { $ref?: string; namespace?: string }>
    >;
  };
  schema: Record<string, unknown>;
}

type RawSchema = Record<string, unknown>;

/** Max `$ref` / `allOf` hops while flattening top-level properties. */
const MAX_COLLECT_PROPS_DEPTH = 12;

/** Max recursion while building nested field schemas. */
const MAX_BUILD_PROPERTY_DEPTH = 8;

/**
 * Above this branch count, a block-ref union (e.g. the `__SECTION_REF__`
 * "pick any section" selector, which lists every section in the site) is
 * treated as lazy: we emit the option list but skip materializing each
 * branch's nested `schema`. The selected branch is resolved on demand via
 * `resolveSchema()` at selection time, so nothing is lost — and we avoid a
 * combinatorial blow-up when many of those sections have their own `Section`
 * field pointing back at the same union.
 */
const MAX_ANYOF_EAGER_SCHEMA_BRANCHES = 40;

/**
 * Definition key for the "pick any section" union (mirrors the meta composer's
 * `SECTION_REF_DEF_KEY`). Section-typed props (`children`, `fallback`, …) `$ref`
 * this; not every meta materializes the def, so {@link resolveSchema} falls back
 * to `root.sections` when it's missing.
 */
const SECTION_REF_DEF_KEY = "__SECTION_REF__";

function isArraySchemaBranch(schema: RawSchema): boolean {
  const t = schema.type;
  return t === "array" || (Array.isArray(t) && t.includes("array"));
}

/**
 * Section/loader arrays (items carry `__resolveType` or `anyOf`) vs config
 * arrays (plain object items, e.g. app flag lists).
 */
function isSectionLoaderArrayBranch(
  branch: RawSchema,
  resolveRef: (ref: string) => RawSchema,
): boolean {
  let items = branch.items as RawSchema | undefined;
  if (!items) return false;
  if (typeof items.$ref === "string") {
    items = resolveRef(items.$ref);
  }
  if (Array.isArray(items.anyOf) || Array.isArray(items.oneOf)) return true;
  const props = items.properties as RawSchema | undefined;
  const rtEnum = (props?.__resolveType as RawSchema | undefined)?.enum;
  return Array.isArray(rtEnum) && typeof rtEnum[0] === "string";
}

// deco.cx convention: VideoWidget schemas don't carry `format` in their
// JSON Schema definition, so we inject it here so the UI can render a
// VideoField instead of a generic FileField. If the schema ever gains the
// `format` field natively this guard becomes a no-op.
const VIDEO_WIDGET_REF_KEY = "VideoWidget";

/** Base64 encode resolveType keys — browser-safe (btoa), Node fallback in tests. */
function toBase64(str: string): string {
  if (typeof btoa === "function") return btoa(str);
  return Buffer.from(str).toString("base64");
}

function parseSiteAppResolveType(
  resolveType: string,
): { vendor: string; app: string } | null {
  const match = resolveType.match(/^site\/apps\/([^/]+)\/([^/.]+)\.tsx?$/);
  if (!match) return null;
  return { vendor: match[1]!, app: match[2]! };
}

function parseLegacyAppResolveType(
  resolveType: string,
): { vendor: string; app: string } | null {
  const match = resolveType.match(/^([^/]+)\/apps\/([^/.]+)\.tsx?$/);
  if (!match) return null;
  return { vendor: match[1]!, app: match[2]! };
}

function appManifestResolveTypeAliases(vendor: string, app: string): string[] {
  return [
    `site/apps/${vendor}/${app}.ts`,
    `site/apps/${vendor}/${app}.tsx`,
    `${vendor}/apps/${app}.ts`,
    `${vendor}/apps/${app}.tsx`,
  ];
}

/** Manifest block schema entry, including legacy/modern app resolveType aliases. */
function lookupManifestBlockSchema(
  resolveType: string,
  meta: LiveMeta,
): RawSchema {
  const allBlockTypes = meta.manifest?.blocks ?? {};

  for (const blockTypeMap of Object.values(allBlockTypes)) {
    if (blockTypeMap[resolveType]) {
      return blockTypeMap[resolveType] as RawSchema;
    }
  }

  const parsed =
    parseSiteAppResolveType(resolveType) ??
    parseLegacyAppResolveType(resolveType);
  if (parsed) {
    for (const alias of appManifestResolveTypeAliases(
      parsed.vendor,
      parsed.app,
    )) {
      for (const blockTypeMap of Object.values(allBlockTypes)) {
        if (blockTypeMap[alias]) {
          return blockTypeMap[alias] as RawSchema;
        }
      }
    }
  }

  // Tanstack sites generate app schemas with base64-encoded resolveType keys
  // (same convention as sections). Fall back when manifest.blocks.apps is empty.
  const encodedResolveType = toBase64(resolveType);
  for (const blockTypeMap of Object.values(allBlockTypes)) {
    if (blockTypeMap[encodedResolveType]) {
      return blockTypeMap[encodedResolveType] as RawSchema;
    }
  }

  const globalSchema = meta.schema ?? {};
  const defs = (globalSchema.$defs ?? globalSchema.definitions ?? {}) as Record<
    string,
    unknown
  >;
  if (defs[encodedResolveType]) {
    return { $ref: `#/definitions/${encodedResolveType}` };
  }

  return {};
}

/** Whether resolveType refers to a manifest `apps` block (legacy + site/apps aliases). */
export function isResolvableManifestApp(
  meta: LiveMeta,
  resolveType: string,
): boolean {
  if (isManifestAppResolveType(meta, resolveType)) return true;
  const parsed =
    parseSiteAppResolveType(resolveType) ??
    parseLegacyAppResolveType(resolveType);
  if (!parsed) return false;
  const apps = meta.manifest?.blocks?.apps ?? {};
  if (
    appManifestResolveTypeAliases(parsed.vendor, parsed.app).some(
      (alias) => alias in apps,
    )
  ) {
    return true;
  }
  const encodedResolveType = toBase64(resolveType);
  const defs = (meta.schema?.$defs ?? meta.schema?.definitions ?? {}) as Record<
    string,
    unknown
  >;
  return encodedResolveType in defs;
}

/**
 * Whether resolveType is a deco app module path (site/apps or legacy vendor/apps),
 * excluding the site app itself. Used to detect installed custom/local apps even
 * when they are missing from manifest.blocks.apps.
 */
export function isDecoAppResolveType(resolveType: string): boolean {
  if (resolveType === "site/apps/site.ts") return false;
  return (
    parseSiteAppResolveType(resolveType) !== null ||
    parseLegacyAppResolveType(resolveType) !== null
  );
}

/**
 * Resolve the schema for a given __resolveType by searching across ALL
 * block types in the manifest (sections, loaders, matchers, etc.).
 */
export function resolveSchema(
  resolveType: string,
  meta: LiveMeta,
): SchemaProperty | null {
  const globalSchema = meta.schema ?? {};
  const blockSchema = lookupManifestBlockSchema(resolveType, meta);
  // Always read $defs/definitions from the global live schema. Manifest block
  // entries often carry `$ref` plus an empty `definitions` object; spreading
  // blockSchema over globalSchema clobbers the real defs and breaks $ref
  // resolution (common for site/apps/site.ts → SiteApp).
  const defs = (globalSchema.$defs ?? globalSchema.definitions ?? {}) as Record<
    string,
    unknown
  >;

  // deco "block registry" unions live under `#/root/<blockType>` (matchers,
  // sections, loaders, …) — the anyOf of every implementation plus saved
  // blocks. These are siblings of `definitions`, so the last-segment lookup
  // below misses them (`#/root/matchers` → `matchers`, absent from defs → {}).
  // Recursive block-ref fields (e.g. Multi's `matchers: Matcher[]`) chain into
  // one of these, so without this branch they resolve to an empty object and
  // the field renders blank.
  const root = (globalSchema.root ?? {}) as Record<string, unknown>;
  const resolveRef = (ref: string): RawSchema => {
    if (ref.startsWith("#/root/")) {
      const rootKey = ref.slice("#/root/".length);
      return (root[rootKey] as RawSchema | undefined) ?? {};
    }
    const key = ref.split("/").pop() ?? "";
    const def = defs[key] as RawSchema | undefined;
    if (def) return def;
    // `__SECTION_REF__` is the "pick any section" union that Section-typed fields
    // (e.g. NotFoundChallenge's `children`/`fallback`) point at. It's an alias
    // the meta composer materializes FROM `root.sections.anyOf`, so metas that
    // aren't self-contained (raw generateMeta output, or a snapshot baked by a
    // CLI/runtime version that didn't emit the def) reference it without ever
    // defining it. Fall back to the section registry so the field renders the
    // section picker instead of collapsing to an empty object (blank field, no
    // way to pick a section).
    if (key === SECTION_REF_DEF_KEY) {
      return (root.sections as RawSchema | undefined) ?? {};
    }
    return {};
  };

  let schemaRoot: RawSchema;
  if (typeof blockSchema.$ref === "string") {
    schemaRoot = resolveRef(blockSchema.$ref);
  } else if (Object.keys(blockSchema).length > 0) {
    schemaRoot = blockSchema;
  } else {
    schemaRoot = globalSchema;
  }

  const resolveBranchDef = (branch: RawSchema): RawSchema => {
    if (typeof branch.$ref === "string") {
      return resolveRef(branch.$ref);
    }
    return branch;
  };

  const typeDiscriminatorFromBranch = (
    branch: RawSchema,
  ): string | undefined => {
    const def = resolveBranchDef(branch);
    const typeProp = (def.properties as RawSchema | undefined)?.type as
      | RawSchema
      | undefined;
    if (!typeProp) return undefined;
    if (typeof typeProp.const === "string") return typeProp.const;
    if (typeof typeProp.default === "string") return typeProp.default;
    if (Array.isArray(typeProp.enum) && typeof typeProp.enum[0] === "string") {
      return typeProp.enum[0];
    }
    return undefined;
  };

  const branchTitle = (branch: RawSchema, fallback: string): string => {
    const def = resolveBranchDef(branch);
    if (typeof def.title === "string" && !def.title.startsWith("#")) {
      return def.title;
    }
    return fallback;
  };

  /** Follow pure `$ref` aliases (e.g. CardType → ImageCard|TextCard). */
  const unwrapRefAliases = (
    s: RawSchema,
    seen: Set<string> = new Set(),
  ): RawSchema => {
    if (typeof s.$ref !== "string") return s;
    if (s.properties || s.anyOf || s.allOf || s.oneOf || s.type) return s;
    const key = s.$ref.split("/").pop() ?? "";
    if (!key || seen.has(key)) return s;
    return unwrapRefAliases(resolveRef(s.$ref), new Set([...seen, key]));
  };

  const isSchemaHidden = (s: RawSchema): boolean => {
    const hide = s.hide;
    return hide === true || hide === "true";
  };

  /**
   * Recursively follow $ref / allOf / anyOf / oneOf and merge all
   * `properties` objects found. seenRefs guards against cycles.
   */
  const collectProps = (
    s: RawSchema,
    seenRefs: Set<string> = new Set(),
    depth = 0,
  ): RawSchema => {
    if (depth > MAX_COLLECT_PROPS_DEPTH) return {};

    if (typeof s.$ref === "string") {
      const key = s.$ref.split("/").pop() ?? "";
      if (seenRefs.has(key)) return {};
      return collectProps(
        resolveRef(s.$ref),
        new Set([...seenRefs, key]),
        depth + 1,
      );
    }

    let props: RawSchema = {};

    if (s.properties && typeof s.properties === "object") {
      props = { ...props, ...(s.properties as RawSchema) };
    }

    // Merge required arrays from allOf/anyOf/oneOf members
    if (Array.isArray(s.required)) {
      const existing = Array.isArray(props.__required)
        ? (props.__required as string[])
        : [];
      props.__required = [...existing, ...(s.required as string[])];
    }

    for (const k of ["allOf", "anyOf", "oneOf"] as const) {
      const arr = (s as Record<string, unknown>)[k];
      if (!Array.isArray(arr)) continue;
      for (const part of arr as RawSchema[]) {
        props = { ...props, ...collectProps(part, seenRefs, depth + 1) };
      }
    }

    return props;
  };

  /**
   * Converts a raw schema entry into a typed SchemaProperty, resolving
   * nested properties for object types (up to depth 3).
   */
  const buildProperty = (
    v: RawSchema,
    depth = 0,
    seen: Set<string> = new Set(),
  ): SchemaProperty => {
    let resolved = v;
    let vRefKey: string | undefined;
    if (typeof v.$ref === "string") {
      resolved = resolveRef(v.$ref);
      const refKey = v.$ref.split("/").pop() ?? "";
      vRefKey = refKey;
      if (refKey === VIDEO_WIDGET_REF_KEY && !resolved.format) {
        resolved = { ...resolved, format: "video-uri" };
      }
    }
    resolved = unwrapRefAliases(resolved);

    // Cycle guard for recursive block-ref unions. The `__SECTION_REF__`
    // "pick any section" selector lists every section, and 20+ of those
    // sections themselves have a `Section` field pointing back at the same
    // union. Without this guard, eagerly materializing each branch's nested
    // `schema` recurses ~exponentially and blows up browser memory (multi-GB).
    // When we re-enter a union already on the current path, we still emit the
    // selector's option list but skip the per-branch nested schema — the UI
    // resolves the selected branch lazily via resolveSchema().
    const cyclicUnion = vRefKey !== undefined && seen.has(vRefKey);
    const unionSeen =
      vRefKey !== undefined ? new Set([...seen, vRefKey]) : seen;

    /**
     * Build a union branch's nested schema, unless doing so would recurse into
     * a cycle or expand an oversized selector. Returns `undefined` in those
     * cases so the branch is resolved lazily on selection.
     *
     * The oversized-union skip only applies when branches are `lazilyResolvable`
     * — i.e. keyed by a module `__resolveType` that `resolveSchema()` can
     * re-resolve on selection (section/loader selectors). Type-discriminated
     * unions (keyed by a `type` discriminator, no module resolveType) have no
     * lazy fallback, so their branch schemas must stay eager regardless of
     * count; only the cycle/depth guards apply to them.
     */
    const eagerBranchSchema = (
      branch: RawSchema,
      branchDepth: number,
      branchCount: number,
      lazilyResolvable = true,
    ): SchemaProperty | undefined =>
      !cyclicUnion &&
      (!lazilyResolvable || branchCount <= MAX_ANYOF_EAGER_SCHEMA_BRANCHES) &&
      branchDepth < MAX_BUILD_PROPERTY_DEPTH
        ? buildProperty(branch, branchDepth, unionSeen)
        : undefined;

    // Extract enum values from anyOf/oneOf const/enum branches
    let enumFromConsts: unknown[] | undefined;
    {
      const unionArr = (resolved.anyOf ?? resolved.oneOf) as
        | RawSchema[]
        | undefined;
      if (Array.isArray(unionArr)) {
        const nonNullUnion = unionArr.filter(
          (a) => !(a.type === "null" || a.type === null),
        );
        const getScalar = (a: RawSchema): unknown => {
          if (typeof a.const === "string" || typeof a.const === "number")
            return a.const;
          if (
            Array.isArray(a.enum) &&
            a.enum.length === 1 &&
            (typeof a.enum[0] === "string" || typeof a.enum[0] === "number")
          )
            return a.enum[0];
          return undefined;
        };
        if (
          nonNullUnion.length > 0 &&
          nonNullUnion.every((a) => getScalar(a) !== undefined)
        ) {
          enumFromConsts = nonNullUnion.map((a) => getScalar(a));
        }
      }
    }

    // Determine type. When the schema is a nullable union
    // (`anyOf: [T, null]`), `unionLeaf` holds the single non-null branch
    // so downstream metadata (format, title, description) can be inherited
    // from it — without this, `format: "image-uri"` on the inner branch
    // would be silently dropped.
    let type: string | undefined;
    let unionLeaf: RawSchema | undefined;
    // When set, `resolved.title` is a machine-generated intersection name, not a label.
    let suppressResolvedTitle = false;
    if (resolved.type) {
      type = Array.isArray(resolved.type)
        ? String(resolved.type.find((t) => t !== "null") ?? resolved.type[0])
        : String(resolved.type);
    } else if (resolved.anyOf || resolved.oneOf) {
      const arr = (resolved.anyOf ?? resolved.oneOf) as RawSchema[];
      const nonNull = arr.filter(
        (a) => !(a.type === "null" || a.type === null),
      );

      if (nonNull.length === 0) {
        type = "null";
      } else if (nonNull.length === 1) {
        const first = nonNull[0]!;
        unionLeaf = first;
        type = first.type
          ? Array.isArray(first.type)
            ? String(first.type[0])
            : String(first.type)
          : typeof first.$ref === "string"
            ? "object"
            : "string";
      } else {
        // const-only branches: TypeScript string/number enum
        if (enumFromConsts) {
          // A union of literals can still carry widget annotations
          // (`@format icon-select` / `@options loader.ts` on the prop) —
          // dropping them here would demote the field to a static select.
          const annotation = (key: "format" | "options"): string | undefined =>
            typeof v[key] === "string"
              ? (v[key] as string)
              : typeof resolved[key] === "string"
                ? (resolved[key] as string)
                : undefined;
          return {
            type: "string",
            title:
              typeof resolved.title === "string" ? resolved.title : undefined,
            description:
              typeof resolved.description === "string"
                ? resolved.description
                : undefined,
            enum: enumFromConsts,
            format: annotation("format"),
            options: annotation("options"),
          };
        }

        // deco.cx inline loader branches
        const loaderBranches = nonNull.filter((a) => {
          const rtEnum = (
            (a.properties as RawSchema | undefined)?.__resolveType as
              | RawSchema
              | undefined
          )?.enum;
          return Array.isArray(rtEnum) && typeof rtEnum[0] === "string";
        });

        // Site `global` / page `sections`: plain section arrays with an optional
        // page multivariate flag branch. Prefer the array (admin hides the flag UI).
        // App config arrays (e.g. flag lists) share anyOf with product-list loaders;
        // prefer the array branch when items are plain objects, not section refs.
        const arrayBranch = nonNull
          .map((branch) => unwrapRefAliases(branch))
          .find(isArraySchemaBranch);
        const hasPageMultivariateLoader = loaderBranches.some((branch) => {
          const rtEnum = (
            (branch.properties as RawSchema | undefined)?.__resolveType as
              | RawSchema
              | undefined
          )?.enum;
          return (
            Array.isArray(rtEnum) &&
            rtEnum[0] === PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE
          );
        });
        if (arrayBranch) {
          const isConfigArray = !isSectionLoaderArrayBranch(
            arrayBranch,
            resolveRef,
          );
          if (isConfigArray && nonNull.length > 1) {
            const built = buildProperty(arrayBranch, depth + 1, unionSeen);
            return {
              ...built,
              type: "array",
              title:
                typeof resolved.title === "string"
                  ? resolved.title
                  : built.title,
              description:
                typeof resolved.description === "string"
                  ? resolved.description
                  : built.description,
            };
          }
          if (hasPageMultivariateLoader) {
            const built = buildProperty(arrayBranch, depth + 1, unionSeen);
            return {
              ...built,
              type: "array",
              title:
                typeof resolved.title === "string"
                  ? resolved.title
                  : built.title,
              description:
                typeof resolved.description === "string"
                  ? resolved.description
                  : built.description,
            };
          }
        }

        if (loaderBranches.length > 0) {
          const loaderRefs = loaderBranches.map((branch) => {
            const rtSchema = (branch.properties as RawSchema | undefined)
              ?.__resolveType as RawSchema | undefined;
            const rtEnum = (rtSchema?.enum ?? []) as unknown[];
            const rt = String(rtEnum[0]);
            return {
              resolveType: rt,
              title:
                typeof branch.title === "string"
                  ? branch.title
                  : labelFromResolveType(rt),
              description:
                typeof branch.description === "string"
                  ? branch.description
                  : undefined,
              schema: eagerBranchSchema(branch, depth + 1, nonNull.length),
            };
          });

          // Block-registry unions (`#/root/matchers`, etc.) mix inline loader
          // branches (saved blocks) with `$ref` branches (the built-in module
          // types). Fold those `$ref` branches in too, otherwise selecting a
          // Multi matcher only offers saved matchers, not `cookie`/`device`/…
          // The `Resolvable` fallback ref (no `__resolveType`) is skipped.
          const refBranchRefs: SchemaAnyOfRef[] = [];
          for (const branch of nonNull) {
            if (loaderBranches.includes(branch)) continue;
            if (typeof branch.$ref !== "string") continue;
            const def = resolveRef(branch.$ref);
            let rt: string | undefined;
            const rtProp = (def.properties as RawSchema | undefined)
              ?.__resolveType as RawSchema | undefined;
            if (
              Array.isArray(rtProp?.enum) &&
              typeof rtProp.enum[0] === "string"
            ) {
              rt = rtProp.enum[0];
            }
            if (!rt && Array.isArray(def.allOf)) {
              for (const part of def.allOf as RawSchema[]) {
                const e = (
                  (part.properties as RawSchema | undefined)?.__resolveType as
                    | RawSchema
                    | undefined
                )?.enum;
                if (Array.isArray(e) && typeof e[0] === "string") {
                  rt = e[0];
                  break;
                }
              }
            }
            if (!rt) continue;
            refBranchRefs.push({
              resolveType: rt,
              title:
                typeof def.title === "string" && !def.title.startsWith("#")
                  ? def.title
                  : labelFromResolveType(rt),
              description:
                typeof def.description === "string"
                  ? def.description
                  : undefined,
              schema: eagerBranchSchema(def, depth + 1, nonNull.length),
            });
          }

          const seenRt = new Set(loaderRefs.map((r) => r.resolveType));
          const anyOfRefs = [
            ...loaderRefs,
            ...refBranchRefs.filter((r) => !seenRt.has(r.resolveType)),
          ];

          // Preserve the non-loader (plain data) branch so multivariate
          // field rendering can use it instead of the circular block-ref.
          const nonLoaderBranches = nonNull.filter(
            (a) => !loaderBranches.includes(a),
          );
          const plainSchema =
            nonLoaderBranches.length === 1
              ? eagerBranchSchema(
                  nonLoaderBranches[0]!,
                  depth + 1,
                  nonNull.length,
                )
              : undefined;

          return {
            type: "block-ref",
            title:
              typeof resolved.title === "string" ? resolved.title : undefined,
            description:
              typeof resolved.description === "string"
                ? resolved.description
                : undefined,
            anyOfRefs,
            plainSchema,
            hidden:
              isSchemaHidden(resolved) || isSchemaHidden(v) ? true : undefined,
          };
        }

        // Unions discriminated by a `type` field (e.g. ImageCard | TextCard).
        const typeDiscriminators = nonNull.map((branch) =>
          typeDiscriminatorFromBranch(branch),
        );
        const isTypeDiscriminatedUnion =
          nonNull.length > 1 &&
          typeDiscriminators.every((disc) => typeof disc === "string");

        if (isTypeDiscriminatedUnion) {
          const anyOfRefs = nonNull.map((branch, index) => {
            const def = resolveBranchDef(branch);
            const discriminatorValue = typeDiscriminators[index]!;
            return {
              resolveType: discriminatorValue,
              title: branchTitle(branch, discriminatorValue),
              description:
                typeof def.description === "string"
                  ? def.description
                  : undefined,
              discriminatorValue,
              // Type-discriminated branches have no module resolveType to
              // re-resolve from, so keep them eager regardless of union size.
              schema: eagerBranchSchema(def, depth + 1, nonNull.length, false),
            };
          });
          return {
            type: "block-ref",
            title:
              typeof v.title === "string"
                ? v.title
                : typeof resolved.title === "string"
                  ? resolved.title
                  : undefined,
            description:
              typeof v.description === "string"
                ? v.description
                : typeof resolved.description === "string"
                  ? resolved.description
                  : undefined,
            discriminatorKey: "type",
            anyOfRefs,
            hidden:
              isSchemaHidden(resolved) || isSchemaHidden(v) ? true : undefined,
          };
        }

        // A union branch is a real module/block (loader, section, saved block)
        // only when its resolved def carries a `__resolveType` or a saved-block
        // title. Deco also emits plain *data* unions (e.g. `Location | Map`) as
        // an anyOf of `$ref`s to bare object defs with none of those — those must
        // render as an inline branch selector, NOT as a block picker (which would
        // find no resolveType, drop every branch at the `continue` below, and
        // return an empty block-ref that renders as `[object Object]`).
        const branchHasModuleIdentity = (branch: RawSchema): boolean => {
          const def = resolveBranchDef(branch);
          if (
            typeof def.title === "string" &&
            parseSavedBlockSchemaTitle(def.title)
          ) {
            return true;
          }
          const rtEnum = (
            (def.properties as RawSchema | undefined)?.__resolveType as
              | RawSchema
              | undefined
          )?.enum;
          if (Array.isArray(rtEnum) && typeof rtEnum[0] === "string") {
            return true;
          }
          if (Array.isArray(def.allOf)) {
            for (const part of def.allOf as RawSchema[]) {
              const e = (
                (part.properties as RawSchema | undefined)?.__resolveType as
                  | RawSchema
                  | undefined
              )?.enum;
              if (Array.isArray(e) && typeof e[0] === "string") return true;
            }
          }
          return false;
        };
        // A plain-data union (Location | Map): every branch — inline or behind a
        // `$ref` — resolves to a bare object with no module identity.
        const branchIsPlainDataObject = (branch: RawSchema): boolean => {
          if (branchHasModuleIdentity(branch)) return false;
          const def = resolveBranchDef(branch);
          return def.type === "object" || Boolean(def.properties);
        };
        const isChoiceUnion =
          Array.isArray(resolved.anyOf) || Array.isArray(resolved.oneOf);
        const isPlainDataUnion =
          isChoiceUnion &&
          depth < MAX_BUILD_PROPERTY_DEPTH &&
          nonNull.every(branchIsPlainDataObject);

        // All branches are $refs to block/loader defs
        const allRefs = nonNull.every((a) => typeof a.$ref === "string");
        if (allRefs && !isPlainDataUnion) {
          const anyOfRefs: SchemaAnyOfRef[] = [];
          for (const branch of nonNull) {
            const def = resolveRef(branch.$ref as string);
            let rt: string | undefined;
            let title: string | undefined;

            if (typeof def.title === "string") {
              const saved = parseSavedBlockSchemaTitle(def.title);
              if (saved) {
                rt = saved.blockId;
                title = saved.blockId;
              }
            }

            if (!rt && Array.isArray(def.allOf)) {
              for (const part of def.allOf as RawSchema[]) {
                const props = (part.properties ?? {}) as RawSchema;
                const rtProp = (props.__resolveType ?? {}) as RawSchema;
                const e = rtProp.enum;
                if (Array.isArray(e) && typeof e[0] === "string") {
                  rt = e[0];
                  break;
                }
              }
            }
            // @decocms/start ≥6.10 emits flat loader defs (no allOf) with
            // __resolveType.enum directly in properties — check that too.
            if (!rt) {
              const rtProp = (def.properties as RawSchema | undefined)
                ?.__resolveType as RawSchema | undefined;
              const e = rtProp?.enum;
              if (Array.isArray(e) && typeof e[0] === "string") {
                rt = e[0];
              }
            }
            if (!rt) {
              rt = (branch.$ref as string).split("/").pop() ?? "";
            }
            const discriminatorValue = typeDiscriminatorFromBranch(branch);
            // Skip the `Resolvable` placeholder: it has no `__resolveType.enum`
            // so `rt` degrades to the bare ref key (no `/`). All real module
            // blocks (matchers, loaders, sections) contain `/` in their path.
            if (!discriminatorValue && !rt.includes("/")) continue;
            anyOfRefs.push({
              resolveType: discriminatorValue ?? rt,
              title:
                title ??
                (typeof def.title === "string" && !def.title.startsWith("#")
                  ? def.title
                  : labelFromResolveType(rt)),
              description:
                typeof def.description === "string"
                  ? def.description
                  : undefined,
              discriminatorValue,
              schema: eagerBranchSchema(def, depth + 1, nonNull.length),
            });
          }
          return {
            type: "block-ref",
            title:
              typeof resolved.title === "string" ? resolved.title : undefined,
            description:
              typeof resolved.description === "string"
                ? resolved.description
                : undefined,
            anyOfRefs,
            hidden:
              isSchemaHidden(resolved) || isSchemaHidden(v) ? true : undefined,
          };
        }

        // Inline object union with no $ref / loader / `type` discriminator: a
        // plain "A or B" data union (e.g. Location | Map, or a const-tagged
        // union like StaleWhileRevalidate | MaxAge). Render as a branch selector
        // instead of merging every branch's fields into a single form.
        //
        // Only `anyOf`/`oneOf` are choices — `allOf` is an intersection meant to
        // MERGE all branches, so it must fall through to the object-merge path.
        // `isPlainDataUnion` (computed above) already requires a choice union of
        // bare object branches (inline or behind a `$ref`) with no module
        // identity — exactly the `Location | Map` / const-tagged-union shape.
        if (isPlainDataUnion) {
          const constValue = (
            p: RawSchema,
          ): string | number | boolean | undefined => {
            if (
              typeof p.const === "string" ||
              typeof p.const === "number" ||
              typeof p.const === "boolean"
            ) {
              return p.const;
            }
            if (
              Array.isArray(p.enum) &&
              p.enum.length === 1 &&
              (typeof p.enum[0] === "string" ||
                typeof p.enum[0] === "number" ||
                typeof p.enum[0] === "boolean")
            ) {
              return p.enum[0];
            }
            return undefined;
          };
          const inlineUnionBranches = nonNull.map((branch, index) => {
            const branchProps =
              (resolveBranchDef(branch).properties as RawSchema | undefined) ??
              {};
            const discriminators: Record<string, string | number | boolean> =
              {};
            for (const [key, prop] of Object.entries(branchProps)) {
              const cv = constValue(prop as RawSchema);
              if (cv !== undefined) discriminators[key] = cv;
            }
            return {
              title: branchTitle(branch, `Option ${index + 1}`),
              schema: buildProperty(branch, depth + 1),
              discriminators: Object.keys(discriminators).length
                ? discriminators
                : undefined,
            };
          });
          return {
            type: "inline-union",
            title:
              typeof v.title === "string"
                ? v.title
                : typeof resolved.title === "string"
                  ? resolved.title
                  : undefined,
            description:
              typeof resolved.description === "string"
                ? resolved.description
                : undefined,
            inlineUnionBranches,
            hidden:
              isSchemaHidden(resolved) || isSchemaHidden(v) ? true : undefined,
          };
        }

        type = "object";
      }
    } else if (resolved.allOf) {
      /**
       * `allOf` is a type INTERSECTION (A & B), not a choice union. deco emits
       * anonymous intersections like `Omit<RichTextWidget, "tag"> & { tag?: … }`
       * as an allOf of object `$ref`s titled with a machine name
       * ("omitdGFnRichTextWidget&tl@1767-1787"). Merge the members into one form
       * (via `collectProps` below), like the legacy admin's `resolveRefs`. It
       * must NOT reach the choice-union branches above: a pure intersection has
       * no discriminator, so every branch is dropped and the field collapses to
       * an empty picker rendered as "[object Object]".
       */
      type = "object";
      suppressResolvedTitle = true;
    } else if (typeof v.$ref === "string") {
      // Last-resort: ref points to a def with no type/union we recognize.
      // Treat as object so nested-property recursion has a chance to fill in.
      type = "object";
    }

    // Nested properties for object types. Bumped past depth 3 because real
    // deco sections nest images at depth 4+ (`images[].desktop.src`); the
    // old cap left those leaves un-resolved and stripped their `format`.
    let nestedProperties: Record<string, SchemaProperty> | undefined;
    if (depth < MAX_BUILD_PROPERTY_DEPTH) {
      const nestedRaw = collectProps(resolved);
      const nestedEntries = Object.entries(nestedRaw).filter(
        ([k]) => !k.startsWith("__") && k !== "@type",
      );
      if (nestedEntries.length > 0) {
        nestedProperties = {};
        for (const [k, raw] of nestedEntries) {
          nestedProperties[k] = buildProperty(
            raw as RawSchema,
            depth + 1,
            unionSeen,
          );
        }
      }
    }

    // Array items
    let itemsSchema: SchemaProperty | undefined;
    if (
      (type === "array" || resolved.type === "array") &&
      depth < MAX_BUILD_PROPERTY_DEPTH
    ) {
      let rawItems = resolved.items as RawSchema | undefined;
      if (rawItems) {
        if (typeof rawItems.$ref === "string") {
          rawItems = resolveRef(rawItems.$ref);
        }
        itemsSchema = buildProperty(rawItems, depth + 1, unionSeen);
        if (
          typeof rawItems.title === "string" &&
          rawItems.title.includes("{{")
        ) {
          itemsSchema.titleBy = rawItems.title;
        }
      }
    }

    const fromLeaf = <T>(key: string): T | undefined => {
      const fromUnion = unionLeaf?.[key];
      return typeof fromUnion === "string" ? (fromUnion as T) : undefined;
    };

    // First source that has the `default` key present wins, even when
    // the value is explicitly `null`. Using `??` here would collapse
    // `default: null` (which deco emits for nullable fields) into "no
    // default", losing meaningful information about the initial value.
    const pickDefault = (): unknown => {
      if ("default" in v) return v.default;
      if ("default" in resolved) return resolved.default;
      if (unionLeaf && "default" in unionLeaf) return unionLeaf.default;
      return undefined;
    };

    return {
      type: type ?? "string",
      title:
        typeof v.title === "string"
          ? v.title
          : !suppressResolvedTitle && typeof resolved.title === "string"
            ? resolved.title
            : fromLeaf<string>("title"),
      description:
        typeof v.description === "string"
          ? v.description
          : typeof resolved.description === "string"
            ? resolved.description
            : fromLeaf<string>("description"),
      default: pickDefault(),
      enum: Array.isArray(resolved.enum)
        ? resolved.enum
        : (enumFromConsts ?? undefined),
      format:
        typeof v.format === "string"
          ? v.format
          : typeof resolved.format === "string"
            ? resolved.format
            : fromLeaf<string>("format"),
      properties: nestedProperties,
      items: itemsSchema,
      hidden: isSchemaHidden(resolved) || isSchemaHidden(v) ? true : undefined,
      titleBy:
        typeof resolved.titleBy === "string"
          ? resolved.titleBy
          : fromLeaf<string>("titleBy"),
      image:
        typeof resolved.image === "string"
          ? resolved.image
          : fromLeaf<string>("image"),
      options:
        typeof v.options === "string"
          ? v.options
          : typeof resolved.options === "string"
            ? resolved.options
            : fromLeaf<string>("options"),
    };
  };

  // deco wraps a block's config as
  //   { type:"object", allOf:[{$ref:<Props>}], properties:{__resolveType:{…}},
  //     required:["__resolveType"] }
  // (see @deco/deco engine/schema builder.ts). When `<Props>` is itself a
  // discriminated / plain-data union (e.g. the VTEX `userSegment` matcher:
  // AnonymousWithoutCart | … | LoggedInWithRecentOrders), `collectProps` would
  // flatten every branch into a single object — dropping the variant selector
  // and collapsing the hidden discriminant so only a stray field survives.
  // Instead render the union as a branch selector (like the legacy admin),
  // carrying the block's `__resolveType` as a constant discriminator on every
  // branch so it is preserved when the editor picks a branch.
  const ownProps = (schemaRoot.properties ?? {}) as Record<string, RawSchema>;
  const onlyPlumbingProps = Object.keys(ownProps).every((k) =>
    k.startsWith("__"),
  );
  // Restrict to deco's single-member wrapper (`allOf:[{$ref:Props}]`). A
  // multi-member `allOf` (base object + union) must NOT early-return the union
  // alone — that would silently drop the base object's fields; let it fall
  // through to the merge instead.
  if (
    Array.isArray(schemaRoot.allOf) &&
    schemaRoot.allOf.length === 1 &&
    onlyPlumbingProps
  ) {
    const rtProp = ownProps.__resolveType as RawSchema | undefined;
    const resolveTypeConst =
      Array.isArray(rtProp?.enum) && typeof rtProp.enum[0] === "string"
        ? (rtProp.enum[0] as string)
        : typeof rtProp?.const === "string"
          ? rtProp.const
          : typeof rtProp?.default === "string"
            ? rtProp.default
            : undefined;
    for (const part of schemaRoot.allOf as RawSchema[]) {
      // deco emits the union `Props` as a `$ref` alias to the real
      // `{ anyOf: [...] }` def (`…@Props` → `…@A|B|C`), so follow the alias
      // chain — resolving a single `$ref` level would stop at the bare alias.
      const def = unwrapRefAliases(part);
      const isChoiceUnion =
        Array.isArray(def.anyOf) || Array.isArray(def.oneOf);
      // A choice union with no own object properties — a plain "A | B | C".
      // (`allOf` intersections and base-object-plus-extension shapes fall
      // through to the normal merge below.)
      if (!isChoiceUnion || def.properties) continue;
      const built = buildProperty(def, 0);
      if (built.type === "inline-union" && built.inlineUnionBranches) {
        // deco names an anonymous union def after its branches
        // ("A|B|C" / a jsdelivr URL "…@Props"). That machine name leaks in as
        // the field label — drop it unless the dev gave the type a real @title.
        // Only treat as machine-generated a URL or pipe-joined identifiers with
        // no spaces, so a human title like "Q&A | Help" is kept.
        const t = built.title;
        const machineTitle =
          typeof t === "string" &&
          (t.includes("://") || /^[^\s|]+(\|[^\s|]+)+$/.test(t));
        return {
          ...built,
          title: machineTitle ? undefined : built.title,
          inlineUnionBranches: resolveTypeConst
            ? built.inlineUnionBranches.map((branch) => ({
                ...branch,
                discriminators: {
                  ...(branch.discriminators ?? {}),
                  __resolveType: resolveTypeConst,
                },
              }))
            : built.inlineUnionBranches,
        };
      }
    }
  }

  // Collect top-level properties and build typed map
  const topRaw = collectProps(schemaRoot);
  const properties: Record<string, SchemaProperty> = {};
  for (const [key, raw] of Object.entries(topRaw)) {
    if (key.startsWith("__") || key === "@type") continue;
    properties[key] = buildProperty(raw as RawSchema, 0);
  }

  if (Object.keys(properties).length === 0) return null;

  return {
    type: "object",
    title: typeof schemaRoot.title === "string" ? schemaRoot.title : undefined,
    properties,
  };
}

/**
 * Whether a block's schema is a "freeform props" stub — the block DOES take
 * props but doesn't publish their schema, so `resolveSchema()` returns null.
 * Tanstack's `registerCommerceLoaders` registers every commerce/vtex loader
 * and action with a `{ additionalProperties: true }` props schema, and its
 * meta composer drops `additionalProperties` on the way out — the emitted def
 * is just `{ properties: { __resolveType: { enum: [<key>] } } }`. Detect both
 * shapes so the runnable editor can offer the raw JSON editor instead of
 * claiming the block takes no input. Deno/fresh defs never embed a
 * self-referential `__resolveType` in a block's props schema, so this is a
 * no-op there.
 */
export function isFreeformPropsSchema(
  resolveType: string,
  meta: LiveMeta,
): boolean {
  const globalSchema = meta.schema ?? {};
  const blockSchema = lookupManifestBlockSchema(resolveType, meta);
  const defs = (globalSchema.$defs ?? globalSchema.definitions ?? {}) as Record<
    string,
    RawSchema
  >;
  const resolved =
    typeof blockSchema.$ref === "string"
      ? (defs[blockSchema.$ref.split("/").pop() ?? ""] ?? {})
      : blockSchema;

  const props = (resolved.properties as Record<string, RawSchema>) ?? {};
  const hasVisibleProps = Object.keys(props).some(
    (key) => !key.startsWith("__"),
  );
  if (hasVisibleProps) return false;

  if (resolved.additionalProperties === true) return true;

  // Tanstack registry-stub signature: the only property is the block's own
  // `__resolveType` enum.
  const resolveTypeProp = props.__resolveType;
  return (
    !!resolveTypeProp &&
    Array.isArray(resolveTypeProp.enum) &&
    resolveTypeProp.enum[0] === resolveType
  );
}

/**
 * Best-effort schema inferred from a concrete props value. Used by the
 * runnable editor when a block doesn't publish its props schema (tanstack
 * commerce/vtex registry stubs — see {@link isFreeformPropsSchema}) but a
 * saved block carries values: a typed form built from those values beats a
 * raw JSON dead-end. Only shapes present in the value are inferable; enums,
 * formats, and optional fields the value doesn't carry are unknowable.
 */
export function inferSchemaFromValue(
  value: Record<string, unknown>,
): SchemaProperty | null {
  const inferOne = (v: unknown): SchemaProperty => {
    switch (typeof v) {
      case "number":
        return { type: "number" };
      case "boolean":
        return { type: "boolean" };
      case "object": {
        if (v === null) return { type: "string" };
        if (Array.isArray(v)) {
          return { type: "array", items: inferOne(v[0]) };
        }
        const nested: Record<string, SchemaProperty> = {};
        for (const [key, item] of Object.entries(v)) {
          if (key.startsWith("__")) continue;
          nested[key] = inferOne(item);
        }
        return { type: "object", properties: nested };
      }
      default:
        return { type: "string" };
    }
  };

  const properties: Record<string, SchemaProperty> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith("__")) continue;
    properties[key] = inferOne(item);
  }
  if (Object.keys(properties).length === 0) return null;
  return { type: "object", properties };
}

export interface BlockSchemaMetadata {
  title?: string;
  description?: string;
  icon?: string;
  logo?: string;
  /** Block marked hidden from pickers (deco `@ignore` / `hide` convention). */
  hidden?: boolean;
}

/**
 * Read block schema metadata (title, description, icon) from live meta.
 * Mirrors admin's getSchemaIcon / getSchemaTitle / getSchemaDescription.
 */
export function resolveBlockSchemaMetadata(
  resolveType: string,
  meta: LiveMeta,
): BlockSchemaMetadata {
  const globalSchema = meta.schema ?? {};
  const blockSchema = lookupManifestBlockSchema(resolveType, meta);
  const defs = (globalSchema.$defs ?? globalSchema.definitions ?? {}) as Record<
    string,
    RawSchema
  >;

  const resolved =
    typeof blockSchema.$ref === "string"
      ? (defs[blockSchema.$ref.split("/").pop() ?? ""] ?? {})
      : Object.keys(blockSchema).length > 0
        ? blockSchema
        : { ...globalSchema, ...blockSchema };

  const icon = (resolved as { icon?: string }).icon;
  const logo = (resolved as { logo?: string }).logo;
  const flags = resolved as {
    hide?: unknown;
    ignore?: unknown;
    unlisted?: unknown;
  };
  const truthy = (v: unknown) => v === true || v === "true";
  const hidden =
    truthy(flags.hide) || truthy(flags.ignore) || truthy(flags.unlisted);

  return {
    title: typeof resolved.title === "string" ? resolved.title : undefined,
    description:
      typeof resolved.description === "string"
        ? resolved.description
        : undefined,
    icon: typeof icon === "string" ? icon : undefined,
    logo: typeof logo === "string" ? logo : undefined,
    hidden: hidden || undefined,
  };
}
