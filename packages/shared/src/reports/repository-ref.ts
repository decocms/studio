/**
 * The repository a Reports diagnostic runs against, as the two
 * sides of the wire agree on it.
 *
 * Reports used to be handed a bare `owner/name` string on github.com. That
 * string cannot name a GitLab project in nested subgroups, cannot distinguish
 * two hosts, and cannot be resolved back to a credential — which is why the
 * audit only ever worked for GitHub. This carries the identity instead, plus
 * the Studio id that resolves to a credential Studio (and only Studio) holds.
 *
 * Studio speaks camelCase and Reports speaks snake_case, so the translation is
 * stated once here rather than at each call site. {@link toWire} and
 * {@link fromWire} are the only places either convention meets the other.
 */

import { z } from "zod";

export const ReportsRepositoryRefSchema = z.object({
  /** Studio `repositories.id` — what the internal read routes take. */
  repositoryId: z.string().min(1),
  provider: z.enum(["github", "gitlab", "bitbucket"]),
  /** `github.com`, `gitlab.acme.dev`, `bitbucket.org`. */
  host: z.string().min(1),
  /** `owner/name`, `group/sub/project`, `workspace/slug`. */
  path: z.string().min(1),
  defaultBranch: z.string().nullable().optional(),
  webUrl: z.string().nullable().optional(),
});

export type ReportsRepositoryRef = z.infer<typeof ReportsRepositoryRefSchema>;

export const ReportsRepositoryRefWireSchema = z.object({
  repository_id: z.string().min(1),
  provider: z.enum(["github", "gitlab", "bitbucket"]),
  host: z.string().min(1),
  path: z.string().min(1),
  default_branch: z.string().nullable().optional(),
  web_url: z.string().nullable().optional(),
});

export type ReportsRepositoryRefWire = z.infer<
  typeof ReportsRepositoryRefWireSchema
>;

export function toWire(ref: ReportsRepositoryRef): ReportsRepositoryRefWire {
  return {
    repository_id: ref.repositoryId,
    provider: ref.provider,
    host: ref.host,
    path: ref.path,
    default_branch: ref.defaultBranch ?? null,
    web_url: ref.webUrl ?? null,
  };
}

/** Parse a wire payload, or null when it is absent or malformed. */
export function fromWire(value: unknown): ReportsRepositoryRef | null {
  const parsed = ReportsRepositoryRefWireSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    repositoryId: parsed.data.repository_id,
    provider: parsed.data.provider,
    host: parsed.data.host,
    path: parsed.data.path,
    defaultBranch: parsed.data.default_branch ?? null,
    webUrl: parsed.data.web_url ?? null,
  };
}

/**
 * The identity two references are compared on — fingerprints, dedup, and the
 * stamp a stored refinement carries so a brief written against one repository
 * is never replayed against another.
 *
 * Case-insensitive on the path, because every provider treats a repository
 * path that way, and provider-qualified, because the same `acme/site` on two
 * hosts is two repositories. The same rule as Studio's `repoIdentityKey`, plus
 * the provider.
 */
export function repoKey(
  ref: Pick<ReportsRepositoryRef, "provider" | "host" | "path">,
): string {
  return `${ref.provider}:${ref.host.toLowerCase()}/${ref.path.toLowerCase()}`;
}

/**
 * The legacy `owner/name` string, for a reader still on it.
 *
 * Only a github.com repository has one: a GitLab path with subgroups or a
 * Bitbucket workspace slug in this field would be a string the old reader
 * parses into the wrong thing. Null says "this repository has no legacy
 * spelling", which is the honest answer.
 */
export function legacyGithubRepo(ref: ReportsRepositoryRef): string | null {
  return ref.provider === "github" && ref.host.toLowerCase() === "github.com"
    ? ref.path
    : null;
}

/** A github.com `owner/name` string as a reference, for a record written before ids. */
export function fromLegacyGithubRepo(
  value: string,
): Omit<ReportsRepositoryRef, "repositoryId"> | null {
  const path = value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(path)) return null;
  return { provider: "github", host: "github.com", path };
}
