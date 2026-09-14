/**
 * How each provider is spoken to on the command line and in prose.
 *
 * An agent's prompt has to name a concrete command — "open a pull request" is
 * not runnable — so the vocabulary has to vary with the provider rather than
 * hardcode GitHub's. Pure data; the sandbox image ships the CLIs that exist
 * and the checkout's own credential decides which one is authenticated.
 *
 * Bitbucket has no official CLI, so its "command" is the REST API over
 * `curl`. The sandbox exports the checkout's token as `BITBUCKET_TOKEN` for
 * exactly that (see the daemon's `CliEnvFromCloneUrl`).
 */

import type { GitProviderKind } from "./types";

export interface ProviderCli {
  /** The provider's name as people write it. */
  name: string;
  /**
   * The binary the sandbox has authenticated for this provider, or null when
   * the provider ships none and the agent speaks REST instead.
   */
  cli: string | null;
  /** What the provider calls a proposed change, lower case, singular. */
  changeRequest: string;
  /** Its abbreviation, the way a reader of that provider expects it. */
  abbreviation: string;
  /** Opens one from the current checkout. */
  createCommand: string;
  /**
   * Checks an existing one out. `{number}` stands for its number; a provider
   * whose command cannot address it by number names the source branch instead.
   */
  checkoutCommand: string;
  /** How the provider writes a change request's number in prose. */
  numberSigil: string;
}

const CLIS: Record<GitProviderKind, ProviderCli> = {
  github: {
    name: "GitHub",
    cli: "gh",
    changeRequest: "pull request",
    abbreviation: "PR",
    createCommand: "gh pr create",
    checkoutCommand: "gh pr checkout {number}",
    numberSigil: "#",
  },
  gitlab: {
    name: "GitLab",
    cli: "glab",
    changeRequest: "merge request",
    abbreviation: "MR",
    createCommand: "glab mr create",
    checkoutCommand: "glab mr checkout {number}",
    numberSigil: "!",
  },
  bitbucket: {
    name: "Bitbucket",
    cli: null,
    changeRequest: "pull request",
    abbreviation: "PR",
    createCommand:
      'curl -fsS -X POST -H "Authorization: Bearer $BITBUCKET_TOKEN" -H "Content-Type: application/json" ' +
      "https://api.bitbucket.org/2.0/repositories/<workspace>/<repo>/pullrequests " +
      `-d '{"title":"<title>","source":{"branch":{"name":"<branch>"}},"destination":{"branch":{"name":"<base>"}}}'`,
    // Bitbucket Cloud publishes no per-pull-request ref, so the source branch
    // (on the pull request itself) is the only handle.
    checkoutCommand:
      "git fetch origin <source branch> && git checkout <source branch>",
    numberSigil: "#",
  },
};

export function providerCli(provider: GitProviderKind): ProviderCli {
  return CLIS[provider];
}

/** The checkout command for one change request, its number filled in. */
export function checkoutCommandFor(
  provider: GitProviderKind,
  number: number,
): string {
  return CLIS[provider].checkoutCommand.replace("{number}", String(number));
}

/**
 * A change request in prose, the way its own provider writes it — "PR #7" and
 * "MR !7" are what a reader of that provider expects to see, and a card
 * titled "PR #7" for a merge request is simply wrong.
 */
export function changeRequestLabel(
  provider: GitProviderKind,
  number: number,
): string {
  const { abbreviation, numberSigil } = CLIS[provider];
  return `${abbreviation} ${numberSigil}${number}`;
}
