/**
 * Boot-time backfill for the Studio Pack.
 *
 * `installStudioPack` is idempotent — calling it for an org that already
 * has all four managers is a no-op (each create is gated by findById).
 * This helper drives it for every org in the system so newly-added
 * managers (e.g. Store Manager) are backfilled without a migration.
 */

import type { VirtualMCPStorage } from "@/storage/virtual";

export type EnsureStudioPackOrg = {
  id: string;
  createdBy: string;
};

export interface EnsureStudioPackOptions {
  listOrgs: () => Promise<EnsureStudioPackOrg[]>;
  installer: (
    orgId: string,
    createdBy: string,
    virtualMcpStorage: VirtualMCPStorage,
  ) => Promise<void>;
  virtualMcpStorage: VirtualMCPStorage;
  /**
   * Optional per-org error sink. When set, errors are reported here and
   * iteration continues; when absent, errors are logged via console.error
   * and iteration continues regardless. We never reject the outer promise
   * because the server must boot even if a single org's backfill fails.
   */
  onError?: (orgId: string, error: unknown) => void;
}

export async function ensureStudioPackForAllOrgs(
  opts: EnsureStudioPackOptions,
): Promise<void> {
  const orgs = await opts.listOrgs();
  const handle = (orgId: string, error: unknown) => {
    if (opts.onError) opts.onError(orgId, error);
    else
      console.error(`[studio-pack] backfill failed for org=${orgId}:`, error);
  };

  await Promise.all(
    orgs.map(async (org) => {
      try {
        await opts.installer(org.id, org.createdBy, opts.virtualMcpStorage);
      } catch (error) {
        handle(org.id, error);
      }
    }),
  );
}
