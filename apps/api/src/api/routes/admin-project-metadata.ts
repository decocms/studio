import { z } from "zod";
import {
  isValidSiteSlug,
  resolveAgentSiteSlug,
} from "@decocms/shared/site-slug";

/** What a field's authorization may consult about the target organization. */
export interface ProjectMetadataAuthContext {
  isSiteOwned: (slug: string) => Promise<boolean>;
}

interface ProjectMetadataField<T> {
  /** Validates and normalizes a value to set; `null` always clears the key. */
  schema: z.ZodType<T>;
  /** An error code when the organization may not hold `value`, else null. */
  authorize?: (
    value: T,
    ctx: ProjectMetadataAuthContext,
  ) => Promise<string | null>;
}

const defineField = <T>(field: ProjectMetadataField<T>) =>
  field as ProjectMetadataField<unknown>;

/**
 * Project metadata keys a deployment admin may edit, for settings no
 * org-facing UI exposes. Keys with invariants a single-key write can't keep —
 * `siteSlug` (asset tenancy), `sandboxMap`, `githubRepo` (dual-written with
 * `repository_id`), `runtime` (secret references) — must never be listed.
 */
const ADMIN_PROJECT_METADATA_FIELDS = {
  /** The site whose traffic Monitor and experiment results read. */
  analyticsSiteSlug: defineField({
    schema: z.string().trim().toLowerCase().refine(isValidSiteSlug),
    // Analytics is keyed globally by slug; an unowned one is another tenant's.
    authorize: async (slug: string, ctx) =>
      (await ctx.isSiteOwned(slug)) ? null : "site_not_owned",
  }),
} satisfies Record<string, ProjectMetadataField<unknown>>;

type ProjectMetadataKey = keyof typeof ADMIN_PROJECT_METADATA_FIELDS;

const FIELD_ENTRIES = Object.entries(ADMIN_PROJECT_METADATA_FIELDS) as [
  ProjectMetadataKey,
  ProjectMetadataField<unknown>,
][];

const ProjectMetadataPatchSchema = z
  .object(
    Object.fromEntries(
      FIELD_ENTRIES.map(([key, field]) => [
        key,
        field.schema.nullable().optional(),
      ]),
    ),
  )
  .strict();

export interface ProjectMetadataPatch {
  set: Partial<Record<ProjectMetadataKey, unknown>>;
  unset: ProjectMetadataKey[];
}

/** Parse a PATCH body; null for unknown keys, invalid values or no keys. */
export function parseProjectMetadataPatch(
  body: unknown,
): ProjectMetadataPatch | null {
  const parsed = ProjectMetadataPatchSchema.safeParse(body);
  if (!parsed.success) return null;
  const patch: ProjectMetadataPatch = { set: {}, unset: [] };
  for (const [key] of FIELD_ENTRIES) {
    const value = parsed.data[key];
    if (value === undefined) continue;
    if (value === null) patch.unset.push(key);
    else patch.set[key] = value;
  }
  return Object.keys(patch.set).length + patch.unset.length > 0 ? patch : null;
}

/** The first authorization error among the values being set, else null. */
export async function authorizeProjectMetadataPatch(
  patch: ProjectMetadataPatch,
  ctx: ProjectMetadataAuthContext,
): Promise<string | null> {
  for (const [key, field] of FIELD_ENTRIES) {
    if (!(key in patch.set) || !field.authorize) continue;
    const error = await field.authorize(patch.set[key], ctx);
    if (error) return error;
  }
  return null;
}

/** The editable keys of a project's metadata, absent ones as null. */
export function pickProjectMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<ProjectMetadataKey, unknown> {
  return Object.fromEntries(
    FIELD_ENTRIES.map(([key]) => [key, metadata?.[key] ?? null]),
  ) as Record<ProjectMetadataKey, unknown>;
}

/**
 * The org's site projects: those whose resolved slug it owns, the same test
 * experiments use. A migrated project often carries its slug only as its title.
 */
export function listSiteProjects(
  projects: {
    id: string;
    title: string;
    metadata?: (Record<string, unknown> & { siteSlug?: string | null }) | null;
  }[],
  ownedSlugs: ReadonlySet<string>,
) {
  return projects.flatMap((project) => {
    const siteSlug = resolveAgentSiteSlug(project);
    if (!siteSlug || !ownedSlugs.has(siteSlug)) return [];
    return [
      {
        id: project.id,
        title: project.title,
        siteSlug,
        metadata: pickProjectMetadata(project.metadata),
      },
    ];
  });
}
