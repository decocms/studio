/**
 * How each provider is spoken to on the command line and in prose.
 *
 * An agent's prompt has to name a concrete command — "open a pull request" is
 * not runnable — so the vocabulary has to vary with the provider rather than
 * hardcode GitHub's. Pure data; the sandbox image ships both CLIs and the
 * checkout's own credential decides which one is authenticated.
 */

import type { GitProviderKind } from "./types";

export interface ProviderCli {
  /** The binary the sandbox has authenticated for this provider. */
  cli: string;
  /** What the provider calls a proposed change, lower case, singular. */
  changeRequest: string;
  /** Opens one from the current checkout. */
  createCommand: string;
  /** Checks an existing one out by its number, which the caller appends. */
  checkoutCommand: string;
}

const CLIS: Record<GitProviderKind, ProviderCli> = {
  github: {
    cli: "gh",
    changeRequest: "pull request",
    createCommand: "gh pr create",
    checkoutCommand: "gh pr checkout",
  },
  gitlab: {
    cli: "glab",
    changeRequest: "merge request",
    createCommand: "glab mr create",
    checkoutCommand: "glab mr checkout",
  },
};

export function providerCli(provider: GitProviderKind): ProviderCli {
  return CLIS[provider];
}
