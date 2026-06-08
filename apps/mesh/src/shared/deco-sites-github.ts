/** GitHub org where deco.cx platform sites are hosted. */
export const DECO_SITES_GITHUB_OWNER = "deco-sites";

export function decoSiteGithubRepo(siteName: string): {
  owner: string;
  name: string;
  url: string;
} {
  return {
    owner: DECO_SITES_GITHUB_OWNER,
    name: siteName,
    url: `https://github.com/${DECO_SITES_GITHUB_OWNER}/${siteName}`,
  };
}
