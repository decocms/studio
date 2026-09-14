import type { VirtualMCPStoragePort } from "../../storage/ports";

interface ProjectOwnerCandidate {
  id: string;
  organization_id: string;
  metadata?: { liveAgentId?: string | null } | null;
}

/** Exact identity + tenant check for a caller-selected report owner. */
export function isValidCommerceReportOwner(
  candidate: ProjectOwnerCandidate | null,
  requestedProjectId: string,
  organizationId: string,
): candidate is ProjectOwnerCandidate {
  return (
    candidate?.id === requestedProjectId &&
    candidate.organization_id === organizationId
  );
}

/** Resolve a selected development project to its exact same-org live project. */
export async function resolveCommerceReportOwnerId(
  virtualMcps: VirtualMCPStoragePort,
  requestedProjectId: string,
  organizationId: string,
  fallbackProjectId: string,
): Promise<string> {
  if (requestedProjectId === fallbackProjectId) return fallbackProjectId;

  const requested = await virtualMcps.findById(
    requestedProjectId,
    organizationId,
  );
  if (
    !isValidCommerceReportOwner(requested, requestedProjectId, organizationId)
  ) {
    throw new Error("Project not found in organization");
  }

  const liveProjectId = requested.metadata?.liveAgentId?.trim();
  if (!liveProjectId || liveProjectId === requestedProjectId) {
    return requestedProjectId;
  }

  const live = await virtualMcps.findById(liveProjectId, organizationId);
  if (!isValidCommerceReportOwner(live, liveProjectId, organizationId)) {
    throw new Error("Live project not found in organization");
  }
  return liveProjectId;
}
