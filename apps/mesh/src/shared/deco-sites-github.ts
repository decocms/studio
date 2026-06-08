/** GitHub org where hosted deco.cx platform sites live by default. */
export const DECO_SITES_GITHUB_OWNER = "deco-sites";

export type DecoSiteGithubRef = {
  owner: string;
  name: string;
  url: string;
};

/**
 * Read `metadata.github` from a deco.cx site row when present:
 * `{ "github": { "owner": "stone-payments", "repo": "ton-site-deco" } }`
 */
export function parseDecoSiteGithubFromMetadata(
  metadata: unknown,
): { owner: string; repo: string } | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const github = (metadata as { github?: unknown }).github;
  if (!github || typeof github !== "object") {
    return null;
  }
  const owner = (github as { owner?: unknown }).owner;
  const repo = (github as { repo?: unknown }).repo;
  if (typeof owner !== "string" || typeof repo !== "string") {
    return null;
  }
  if (owner.length === 0 || repo.length === 0) {
    return null;
  }
  return { owner, repo };
}

/** Resolve the GitHub repo for a deco.cx site, preferring site metadata. */
export function resolveDecoSiteGithubRepo(
  siteName: string,
  metadata?: unknown,
): DecoSiteGithubRef {
  const fromMetadata = metadata
    ? parseDecoSiteGithubFromMetadata(metadata)
    : null;
  const owner = fromMetadata?.owner ?? DECO_SITES_GITHUB_OWNER;
  const name = fromMetadata?.repo ?? siteName;
  return {
    owner,
    name,
    url: `https://github.com/${owner}/${name}`,
  };
}
