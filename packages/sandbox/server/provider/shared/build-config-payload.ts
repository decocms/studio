import type {
  PackageManagerConfig,
  TenantConfig,
} from "../../../daemon-protocol";
import { normalizeCoAuthorIdentity } from "../../../git-co-author";
import type { EnsureOptions } from "../types";

/**
 * Collapses caller intent into the daemon's TenantConfig shape. The daemon
 * auto-starts the dev server whenever a runnable script is present, so no
 * "intent" flag is needed on the wire.
 */
export function buildConfigPayload(args: {
  runtime: "node" | "bun" | "deno";
  packageManager: PackageManagerConfig | null;
  port?: number;
  repo: NonNullable<EnsureOptions["repo"]> | null;
  tenant?: EnsureOptions["tenant"];
  /** Checkout only — the daemon skips install + dev server. */
  cloneOnly?: boolean;
}): Partial<TenantConfig> | null {
  const repo = args.repo;
  const git = repo
    ? {
        repository: {
          cloneUrl: repo.cloneUrl,
          repoName: repo.displayName ?? deriveRepoLabel(repo.cloneUrl),
          ...(repo.branch ? { branch: repo.branch } : {}),
          // Always sent, empty array included — never as an absent-means-none.
          // The daemon's merge reads an absent field as "keep current", so
          // omitting it when the user deletes their last credential row leaves
          // the revoked PAT live in the pod's store for its whole lifetime, and
          // leaves a re-bootstrapped pod holding the previous config's tokens.
          // Same reasoning as `cloneOnly` below.
          submoduleCredentials: repo.submoduleCredentials ?? [],
        },
        // Omitted when there is no user: a tenant warm pool bootstraps its pods
        // with a repo and no author, and the daemon rejects a blank identity
        // outright (and treats an absent one as "not claimed by a user yet").
        ...(repo.userName.trim() || repo.userEmail.trim()
          ? {
              identity: {
                userName: repo.userName,
                userEmail: repo.userEmail,
              },
            }
          : {}),
      }
    : undefined;

  const tenant = args.tenant;
  const operator =
    normalizeCoAuthorIdentity({
      userName: tenant?.userName,
      userEmail: tenant?.userEmail,
    }) ?? undefined;

  const packageManager = args.packageManager
    ? {
        name: args.packageManager.name,
        ...(args.packageManager.path ? { path: args.packageManager.path } : {}),
      }
    : undefined;

  const application = packageManager
    ? {
        packageManager,
        runtime: args.runtime,
        ...(args.port !== undefined ? { port: args.port } : {}),
      }
    : undefined;

  const orgId = tenant?.orgId;

  // `cloneOnly: false` must still reach the daemon; only an absent one is "nothing to say".
  if (
    !git &&
    !application &&
    !operator &&
    args.cloneOnly === undefined &&
    !orgId
  ) {
    return null;
  }
  return {
    ...(git ? { git } : {}),
    ...(operator ? { operator } : {}),
    // Provenance for artifacts that outlive the pod. The daemon does not use it
    // to boot; it stamps it on the golden dependency cache so the shared tier
    // can key by org. Repo hash alone does not isolate two orgs cloning the
    // same public template, and a shared cache without this would let one org's
    // tree restore into another's sandbox.
    ...(orgId ? { orgId } : {}),
    // Always sent when true, never as an absent-means-false: a sandbox reused
    // from a warm pool carries the previous claim's config, so the flag has to
    // be able to turn itself back off on a normal (dev-server) provision.
    ...(args.cloneOnly !== undefined ? { cloneOnly: args.cloneOnly } : {}),
    ...(application ? { application } : {}),
  };
}

function deriveRepoLabel(cloneUrl: string): string {
  try {
    const u = new URL(cloneUrl);
    const trimmed = u.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    return trimmed || u.hostname;
  } catch {
    return cloneUrl;
  }
}
