/**
 * What a run records when the browser or the store's code is out of reach in
 * this install (the browser flag or hosted sandboxes off, no object storage;
 * the git providers not wired yet). Named gaps owned by us: the customer has
 * nothing to fix.
 */

import { repoIdentityOf } from "../verify/studio-repo.ts";
import type { SiteProfile, SourceGap } from "../types.ts";

/** Prefix of every gap about the store's code. */
const CODE_UNAVAILABLE = "código indisponível";

/** Why pages are not opened in this run. */
const BROWSER_UNAVAILABLE = "navegador indisponível nesta instalação";

export const browserGap = (): SourceGap => ({
  source: "browser",
  error: BROWSER_UNAVAILABLE,
});

/** Why captures are not kept: nowhere to put the images. */
export const MEDIA_UNAVAILABLE =
  "armazenamento de imagens indisponível nesta instalação";

/**
 * How this run reads the store's code. Only the gap exists for now: a site
 * project without a repository is the customer's to link; with one, the
 * reading itself is what is missing.
 */
export type CodeAccess = { kind: "gap"; gap: SourceGap };

export function codeAccessFor(
  profile: Pick<SiteProfile, "code_repo" | "sources"> | null,
): CodeAccess {
  if (!repoIdentityOf(profile)) {
    return {
      kind: "gap",
      gap: {
        source: "github",
        error: `${CODE_UNAVAILABLE}: o projeto do site no Studio não tem repositório ligado`,
        owner: "customer",
        key: "repository",
      },
    };
  }
  return {
    kind: "gap",
    gap: {
      source: "github",
      error: `${CODE_UNAVAILABLE}: a leitura do repositório pelo Studio ainda não está ligada neste motor`,
    },
  };
}
