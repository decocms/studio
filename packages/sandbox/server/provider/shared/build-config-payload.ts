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
  /** Extra checkouts beside `repo`; dropped when there is no primary. */
  extraRepos?: EnsureOptions["extraRepos"];
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
        // Empty included: absent means keep-current to the daemon's merge.
        repositories: extraRepoDirNames(
          (args.extraRepos ?? []).map((extra) => extra.cloneUrl),
        ).map((repoName, i) => {
          const extra = (args.extraRepos ?? [])[i]!;
          return {
            cloneUrl: extra.cloneUrl,
            repoName,
            ...(extra.branch ? { branch: extra.branch } : {}),
            submoduleCredentials: extra.submoduleCredentials ?? [],
          };
        }),
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

/**
 * Directory names for the secondary checkouts, one per clone URL and in the
 * same order.
 *
 * `deriveRepoLabel` is the wrong source: it yields `owner/name`, and a
 * secondary's name IS a directory, which the daemon refuses if it carries a
 * separator. So this takes the last path segment, and falls back to
 * `owner-name` for every member of a colliding set — two orgs owning a repo
 * called `checkout` must not share one checkout directory.
 *
 * Exported for the test; the uniqueness rule is the part worth pinning.
 */
export function extraRepoDirNames(cloneUrls: string[]): string[] {
  const parts = cloneUrls.map((url) => {
    const segments = deriveRepoLabel(url).split("/").filter(Boolean);
    const name = segments[segments.length - 1] ?? "repo";
    const owner = segments.length > 1 ? segments[segments.length - 2]! : "";
    return { name, owner };
  });
  const shared = new Set(
    parts.map((p) => p.name).filter((name, i, all) => all.indexOf(name) !== i),
  );
  return parts.map(({ name, owner }) =>
    sanitizeDirName(shared.has(name) && owner ? `${owner}-${name}` : name),
  );
}

/** Bounded to what the daemon accepts: opens on an alphanumeric, no separator. */
function sanitizeDirName(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "");
  return cleaned || "repo";
}
