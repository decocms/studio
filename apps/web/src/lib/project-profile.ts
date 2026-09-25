/**
 * What a project is ABOUT, and what it can DO.
 *
 * Two different things, kept apart on purpose:
 *
 *  - `storeUrl` is substance: a report runs against it, so it changes what the
 *    product does. `platform` is how the project reads.
 *  - the capability predicates below are DERIVED from what someone actually
 *    connected, and they are what turns behaviour on or off.
 *
 * The rule the rest of the app answers to: **capability decides, label
 * describes.** If a screen appears or disappears because of a value someone
 * picked from a list, that value has become a gate and is in the wrong place.
 * Ask what the screen needs in order to exist and read that.
 *
 * This is why there is no `kind` here any more. It named the four things an
 * e-commerce org runs — a site, an app, a store, an automation — but as an
 * EXCLUSIVE choice, when the real ones combine: a storefront with a VTEX
 * account is both. It let a project read "Automation" while holding a store
 * URL, and briefly gated Reports. `platform` already says "this sells
 * somewhere", derived from a real connection, and the project's own icon
 * already carries its identity.
 *
 * All of it lives in `metadata.project`, a key the API's metadata schema
 * already passes through untouched (`.loose()`), so none of this needed a
 * migration or a server change.
 */

/**
 * Commerce platforms Studio knows how to recognise.
 *
 * A VOCABULARY for reading a connection, not a field anyone fills in: which
 * platform a project sells on is already stated by the connection it holds,
 * and asking again only creates a second answer that can disagree with the
 * first.
 */
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
 * Derived rather than declared, for the reason this module exists: a VTEX
 * connection already says "this is VTEX", and a second hand-picked answer
 * beside it can only agree redundantly or disagree wrongly.
 *
 * Matches on the connection's `app_name`/`slug` CONTAINING a platform name,
 * because an org names its instances ("VTEX Farm", "vtex-prod") and the
 * registry id is `deco/vtex`. Pure, and exported for its test.
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
  /** The storefront this project is about — and the report's subject. The one
   *  thing here nobody but the person can know, so the one thing we ask for. */
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

/**
 * The metadata to send on an update that changes a project's profile.
 *
 * `COLLECTION_VIRTUAL_MCP_UPDATE` replaces the whole metadata object, so the
 * caller has to hand back everything it is not changing. Merging here — rather
 * than at each call site — is what keeps a platform change from dropping a
 * project's repo, instructions or sidebar views on the floor.
 */
export function withProjectProfile(
  metadata: unknown,
  patch: StoredProjectProfile,
): Record<string, unknown> {
  const base = isRecord(metadata) ? metadata : {};
  const current = isRecord(base.project) ? base.project : {};
  return { ...base, project: { ...current, ...patch } };
}

/**
 * `https://farm.com.br` from anything a person is likely to paste.
 *
 * Null when the input cannot be read as a host at all, which is what gates the
 * report creation path — a report run against a typo is worse than no report.
 * A bare `localhost` is rejected along with the typos: a storefront has a dot
 * in it, and accepting single-label hosts turns every mis-typed word into a
 * valid address.
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

/**
 * What a project actually HAS. Derived, never declared.
 *
 * Each of these is the consequence of something a person did — imported a
 * repository, named a storefront, connected a platform — so none of them can
 * disagree with reality the way a chosen label can. Behaviour reads these;
 * `platform` is how a project LOOKS, and gates nothing.
 */
export function hasRepository(project: ProjectLike): boolean {
  const metadata = isRecord(project.metadata) ? project.metadata : {};
  const repo = isRecord(metadata.githubRepo) ? metadata.githubRepo : null;
  return !!repo && typeof repo.url === "string" && repo.url.length > 0;
}

export function hasStorefront(project: ProjectLike): boolean {
  return !!readProjectProfile(project).storeUrl;
}

/**
 * Whether the project was created AS a project, rather than being a
 * pre-projects agent someone made to call tools with.
 *
 * Provenance, not semantics: the test is that `metadata.project` exists at
 * all, never what it holds. Having been created in the projects flow is what
 * tells a freshly made, still-empty project apart from a leftover tool bundle.
 */
export function wasCreatedAsProject(project: ProjectLike): boolean {
  const metadata = isRecord(project.metadata) ? project.metadata : {};
  return isRecord(metadata.project);
}

/**
 * Whether the project is anything yet — the gate for destinations that only
 * make sense once there is somewhere for work to land. A repository, an
 * address, a connection, or simply having been created as a project each
 * count.
 */
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

/** `farm.com.br` from `https://www.farm.com.br/feminino` — for a card's subtitle. */
export function storeHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}
