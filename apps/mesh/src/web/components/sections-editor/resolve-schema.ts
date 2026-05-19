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
  /**
   * Present on "block-ref" fields — a union of compatible block types
   * (loaders, sections, etc.). The UI renders a selector instead of
   * a flat form.
   */
  anyOfRefs?: Array<{
    resolveType: string;
    title: string;
    description?: string;
  }>;
}

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

/**
 * Resolve the schema for a given __resolveType by searching across ALL
 * block types in the manifest (sections, loaders, matchers, etc.).
 */
export function resolveSchema(
  resolveType: string,
  meta: LiveMeta,
): SchemaProperty | null {
  const globalSchema = meta.schema ?? {};
  const allBlockTypes = meta.manifest?.blocks ?? {};

  // Find the per-block schema for this resolveType across all block types
  let blockSchema: RawSchema = {};
  for (const blockTypeMap of Object.values(allBlockTypes)) {
    if (blockTypeMap[resolveType]) {
      blockSchema = blockTypeMap[resolveType] as RawSchema;
      break;
    }
  }

  // Merge exactly as admin-mcp does: { ...schema, ...blockSchema }
  const merged: RawSchema = { ...globalSchema, ...blockSchema };
  const defs = (merged.$defs ?? merged.definitions ?? {}) as Record<
    string,
    unknown
  >;

  const resolveRef = (ref: string): RawSchema => {
    const key = ref.split("/").pop() ?? "";
    return (defs[key] as RawSchema | undefined) ?? {};
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
    if (depth > 5) return {};

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
  const buildProperty = (v: RawSchema, depth = 0): SchemaProperty => {
    let resolved = v;
    if (typeof v.$ref === "string") {
      resolved = resolveRef(v.$ref);
    }

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

    // Determine type
    let type: string | undefined;
    if (resolved.type) {
      type = Array.isArray(resolved.type)
        ? String(resolved.type.find((t) => t !== "null") ?? resolved.type[0])
        : String(resolved.type);
    } else if (typeof v.$ref === "string") {
      type = "object";
    } else if (resolved.anyOf || resolved.allOf || resolved.oneOf) {
      const arr = (resolved.anyOf ??
        resolved.allOf ??
        resolved.oneOf) as RawSchema[];
      const nonNull = arr.filter(
        (a) => !(a.type === "null" || a.type === null),
      );

      if (nonNull.length === 0) {
        type = "null";
      } else if (nonNull.length === 1) {
        const first = nonNull[0]!;
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
          return {
            type: "string",
            title:
              typeof resolved.title === "string" ? resolved.title : undefined,
            description:
              typeof resolved.description === "string"
                ? resolved.description
                : undefined,
            enum: enumFromConsts,
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
        if (loaderBranches.length > 0) {
          const anyOfRefs = loaderBranches.map((branch) => {
            const rtSchema = (branch.properties as RawSchema | undefined)
              ?.__resolveType as RawSchema | undefined;
            const rtEnum = (rtSchema?.enum ?? []) as unknown[];
            const rt = String(rtEnum[0]);
            return {
              resolveType: rt,
              title:
                typeof branch.title === "string"
                  ? branch.title
                  : (rt
                      .split("/")
                      .pop()
                      ?.replace(/\.tsx?$/, "")
                      .replace(/[-_]/g, " ") ?? rt),
              description:
                typeof branch.description === "string"
                  ? branch.description
                  : undefined,
            };
          });
          return {
            type: "block-ref",
            title:
              typeof resolved.title === "string" ? resolved.title : undefined,
            description:
              typeof resolved.description === "string"
                ? resolved.description
                : undefined,
            anyOfRefs,
          };
        }

        // All branches are $refs to block/loader defs
        const allRefs = nonNull.every((a) => typeof a.$ref === "string");
        if (allRefs) {
          const anyOfRefs: Array<{
            resolveType: string;
            title: string;
            description?: string;
          }> = [];
          for (const branch of nonNull) {
            const def = resolveRef(branch.$ref as string);
            let rt: string | undefined;
            if (Array.isArray(def.allOf)) {
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
            if (!rt) {
              rt = (branch.$ref as string).split("/").pop() ?? "";
            }
            anyOfRefs.push({
              resolveType: rt,
              title:
                typeof def.title === "string"
                  ? def.title
                  : (rt
                      .split("/")
                      .pop()
                      ?.replace(/\.tsx?$/, "")
                      .replace(/[-_]/g, " ") ?? rt),
              description:
                typeof def.description === "string"
                  ? def.description
                  : undefined,
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
          };
        }

        type = "object";
      }
    }

    // Nested properties for object types (depth < 3)
    let nestedProperties: Record<string, SchemaProperty> | undefined;
    if (depth < 3) {
      const nestedRaw = collectProps(resolved);
      const nestedEntries = Object.entries(nestedRaw).filter(
        ([k]) => !k.startsWith("__") && k !== "@type",
      );
      if (nestedEntries.length > 0) {
        nestedProperties = {};
        for (const [k, raw] of nestedEntries) {
          nestedProperties[k] = buildProperty(raw as RawSchema, depth + 1);
        }
      }
    }

    // Array items
    let itemsSchema: SchemaProperty | undefined;
    if ((type === "array" || resolved.type === "array") && depth < 3) {
      let rawItems = resolved.items as RawSchema | undefined;
      if (rawItems) {
        if (typeof rawItems.$ref === "string") {
          rawItems = resolveRef(rawItems.$ref);
        }
        itemsSchema = buildProperty(rawItems, depth + 1);
      }
    }

    return {
      type: type ?? "string",
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
      default: v.default ?? resolved.default,
      enum: Array.isArray(resolved.enum)
        ? resolved.enum
        : (enumFromConsts ?? undefined),
      format: typeof resolved.format === "string" ? resolved.format : undefined,
      properties: nestedProperties,
      items: itemsSchema,
      titleBy:
        typeof resolved.titleBy === "string" ? resolved.titleBy : undefined,
    };
  };

  // Collect top-level properties and build typed map
  const topRaw = collectProps(merged);
  const properties: Record<string, SchemaProperty> = {};
  for (const [key, raw] of Object.entries(topRaw)) {
    if (key.startsWith("__") || key === "@type") continue;
    properties[key] = buildProperty(raw as RawSchema, 0);
  }

  if (Object.keys(properties).length === 0) return null;

  return {
    type: "object",
    title: typeof merged.title === "string" ? merged.title : undefined,
    properties,
  };
}
