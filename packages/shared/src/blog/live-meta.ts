/**
 * Reading a site's own block schemas out of its `/live/_meta` document.
 *
 * Here rather than in the editor because both sides of the
 * `apps/web ↛ apps/api` wall have to answer the same question — which schema
 * does this `__resolveType` obey? The editor asks it to render a form; the
 * blog's drafting tool asks it to tell a model what props a block takes. Two
 * implementations of a lookup with four alias conventions and a base64
 * fallback is two answers to one question, and the one the model gets would be
 * the one nobody renders.
 */

export interface LiveMeta {
  /** The stack the site was built with; absent on Fresh/Deno, which predates it. */
  framework?: string;
  manifest: {
    blocks: Record<
      string,
      Record<string, { $ref?: string; namespace?: string }>
    >;
  };
  schema: Record<string, unknown>;
  /** Content hash a deco runtime's `/live/_meta` sends with the schema. */
  etag?: string;
}

/** A JSON Schema node as the meta document stores it, before resolution. */
export type RawSchema = Record<string, unknown>;

/** Base64 encode resolveType keys — browser-safe (btoa), Node fallback in tests. */
export function toBase64(str: string): string {
  if (typeof btoa === "function") return btoa(str);
  return Buffer.from(str).toString("base64");
}

export function parseSiteAppResolveType(
  resolveType: string,
): { vendor: string; app: string } | null {
  const match = resolveType.match(/^site\/apps\/([^/]+)\/([^/.]+)\.tsx?$/);
  if (!match) return null;
  return { vendor: match[1]!, app: match[2]! };
}

export function parseLegacyAppResolveType(
  resolveType: string,
): { vendor: string; app: string } | null {
  const match = resolveType.match(/^([^/]+)\/apps\/([^/.]+)\.tsx?$/);
  if (!match) return null;
  return { vendor: match[1]!, app: match[2]! };
}

export function appManifestResolveTypeAliases(
  vendor: string,
  app: string,
): string[] {
  return [
    `site/apps/${vendor}/${app}.ts`,
    `site/apps/${vendor}/${app}.tsx`,
    `${vendor}/apps/${app}.ts`,
    `${vendor}/apps/${app}.tsx`,
  ];
}

/** Manifest block schema entry, including legacy/modern app resolveType aliases. */
export function lookupManifestBlockSchema(
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

  /**
   * Tanstack sites generate app schemas with base64-encoded resolveType keys
   * (same convention as sections). Fall back when manifest.blocks.apps is empty.
   */
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
