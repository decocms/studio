/** Whether an org has connected anything of its OWN.
 *
 *  Every org is seeded at creation with `_self`, `_registry`,
 *  `_community-registry` and `_dev-assets` (see `apps/api/src/auth/org.ts`).
 *  They are `connection_type: "HTTP"`, and the connections list only filters
 *  out `VIRTUAL`, so a zero-day org reads back three or four rows. A bare
 *  `connections.length > 0` therefore answers "has this org been created",
 *  not "has anyone connected a data source".
 *
 *  Mirrors the server's own predicate in
 *  `apps/api/src/tools/virtual/studio-pack/store-manager.ts`, which excludes
 *  the same four ids in SQL. */

import { WellKnownOrgMCPId } from "@decocms/shared/sdk/lib/constants";

function seededConnectionIds(orgId: string): string[] {
  return [
    WellKnownOrgMCPId.SELF(orgId),
    WellKnownOrgMCPId.REGISTRY(orgId),
    WellKnownOrgMCPId.COMMUNITY_REGISTRY(orgId),
    WellKnownOrgMCPId.DEV_ASSETS(orgId),
  ];
}

export function hasOwnConnection(
  connections: ReadonlyArray<{ id: string }>,
  orgId: string,
): boolean {
  const seeded = new Set(seededConnectionIds(orgId));
  return connections.some((connection) => !seeded.has(connection.id));
}
