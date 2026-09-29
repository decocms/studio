/**
 * What a project is ABOUT (`storeUrl`, `platform`) and what it can DO (the
 * capability predicates below).
 *
 * The rule the rest of the app answers to: capability decides, label
 * describes. A screen gates on what it needs to exist, never on a value
 * somebody picked from a list — which is why there is no `kind` field.
 *
 * Stored under `metadata.project`, which the API schema passes through
 * untouched, so none of this needs a migration.
 */

/** A vocabulary for reading a connection, not a field anyone fills in. */
const COMMERCE_PLATFORMS = [
  "vtex",
  "shopify",
  "wake",
  "nuvemshop",
  "linx",
  "vnda",
] as const;

export type CommercePlatform = (typeof COMMERCE_PLATFORMS)[number];

interface ConnectionLike {
  id: string;
  app_name?: string | null;
  slug?: string | null;
}

/**
 * The platform a project sells on, read off the connection it holds.
 *
 * Substring match on `app_name`/`slug`, because orgs name their instances
 * ("VTEX Farm", "vtex-prod") and the registry id is `deco/vtex`.
 */
export function platformFromConnections(
  project: { connections?: readonly { connection_id: string }[] | null },
  connections: readonly ConnectionLike[],
): CommercePlatform | null {
  const held = new Set((project.connections ?? []).map((c) => c.connection_id));
  if (held.size === 0) return null;
  for (const connection of connections) {
    if (!held.has(connection.id)) continue;
    const haystack =
      `${connection.app_name ?? ""} ${connection.slug ?? ""}`.toLowerCase();
    const found = COMMERCE_PLATFORMS.find((p) => haystack.includes(p));
    if (found) return found;
  }
  return null;
}

export interface ProjectProfile {
  /** The storefront this project is about, and the report's subject. */
  storeUrl: string | null;
}

/** The shape we persist. */
export interface StoredProjectProfile {
  storeUrl?: string | null;
}

interface ProjectLike {
  metadata?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The site URL a legacy project already carries, before anyone set one. */
function inferStoreUrl(metadata: Record<string, unknown>): string | null {
  return (
    nonEmpty(metadata.productionUrl) ?? nonEmpty(metadata.previewServerUrl)
  );
}

export function readProjectProfile(project: ProjectLike): ProjectProfile {
  const metadata = isRecord(project.metadata) ? project.metadata : {};
  const stored = isRecord(metadata.project) ? metadata.project : {};
  return { storeUrl: nonEmpty(stored.storeUrl) ?? inferStoreUrl(metadata) };
}

/** `COLLECTION_VIRTUAL_MCP_UPDATE` replaces the whole metadata object, so
 *  merge here rather than at each call site. */
export function withProjectProfile(
  metadata: unknown,
  patch: StoredProjectProfile,
): Record<string, unknown> {
  const base = isRecord(metadata) ? metadata : {};
  const current = isRecord(base.project) ? base.project : {};
  return { ...base, project: { ...current, ...patch } };
}

/**
 * `https://farm.com.br` from anything a person is likely to paste; null when
 * it cannot be read as a host, which gates report creation. Single-label hosts
 * are rejected so a mis-typed word is not a valid address.
 */
export function normalizeStoreUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes(".")) return null;
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return null;
  }
}

/** What a project actually HAS, derived from what someone connected.
 *  Behaviour reads these; `platform` gates nothing. */
export function hasRepository(project: ProjectLike): boolean {
  const metadata = isRecord(project.metadata) ? project.metadata : {};
  const repo = isRecord(metadata.githubRepo) ? metadata.githubRepo : null;
  return !!repo && typeof repo.url === "string" && repo.url.length > 0;
}

export function hasStorefront(project: ProjectLike): boolean {
  return !!readProjectProfile(project).storeUrl;
}

/** Provenance: `metadata.project` existing at all, never what it holds. Tells
 *  a new empty project from a pre-projects agent. */
export function wasCreatedAsProject(project: ProjectLike): boolean {
  const metadata = isRecord(project.metadata) ? project.metadata : {};
  return isRecord(metadata.project);
}

/** Whether the project is anything yet — the gate for destinations that need
 *  somewhere for work to land. */
export function projectHasSubstance(
  project: ProjectLike & { connections?: readonly unknown[] | null },
): boolean {
  return (
    hasRepository(project) ||
    hasStorefront(project) ||
    (project.connections?.length ?? 0) > 0 ||
    wasCreatedAsProject(project)
  );
}

/** `farm.com.br` from `https://www.farm.com.br/feminino`. */
export function storeHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}
