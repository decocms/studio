/**
 * Where to send someone whose task run died on GitHub auth.
 *
 * Both destinations are Studio API routes that redirect on to GitHub, so the
 * link IS the reauth — `/accounts/:id/manage` resolves the live installation
 * and lands on its settings page, which is where GitHub puts the "review and
 * accept new permissions" prompt that clears a 422. Pointing at Studio's own
 * connections page instead only showed the user a list.
 *
 * The account is resolved from the card's repo, so the link opens the
 * installation that actually failed rather than whichever one is first. With no
 * repo, no matching repository, or a repository nothing holds credentials for,
 * there is no installation to reconfigure and the answer is to install the App.
 *
 * `ownerOnly` says the destination is an organization's settings page. GitHub
 * answers 404 there — not 403 — for anyone who merely belongs to the
 * organization, so a member who clicks lands on a bare Not Found with nothing
 * naming the wall they hit. Only an owner can accept an App's new permissions,
 * so the banner says so instead of promising the click will work.
 */
export function githubReauthUrl({
  orgSlug,
  repo,
  repositories,
  returnTo,
}: {
  orgSlug: string;
  repo: string | null;
  repositories: { path: string; accountId: string | null }[];
  returnTo: string;
}): { url: string; ownerOnly: boolean; owner: string | null } {
  const base = `/api/${encodeURIComponent(orgSlug)}/git-providers/github`;
  const accountId = repo
    ? repositories.find((r) => r.path === repo)?.accountId
    : null;
  if (!accountId) {
    return {
      url: `${base}/install?returnTo=${encodeURIComponent(returnTo)}`,
      ownerOnly: false,
      owner: null,
    };
  }
  // `owner/name`; a single-segment path is a user account, whose settings page
  // the user reaches themselves.
  const owner = repo?.includes("/") ? repo.split("/")[0]! : null;
  return {
    url: `${base}/accounts/${encodeURIComponent(accountId)}/manage`,
    ownerOnly: owner !== null,
    owner,
  };
}
