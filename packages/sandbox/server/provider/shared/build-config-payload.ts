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
}): Partial<TenantConfig> | null {
  const repo = args.repo;
  const git = repo
    ? {
        repository: {
          cloneUrl: repo.cloneUrl,
          repoName: repo.displayName ?? deriveRepoLabel(repo.cloneUrl),
          ...(repo.branch ? { branch: repo.branch } : {}),
          ...(repo.submoduleCredentials && repo.submoduleCredentials.length > 0
            ? { submoduleCredentials: repo.submoduleCredentials }
            : {}),
        },
        identity: {
          userName: repo.userName,
          userEmail: repo.userEmail,
        },
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

  if (!git && !application && !operator) return null;
  return {
    ...(git ? { git } : {}),
    ...(operator ? { operator } : {}),
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
