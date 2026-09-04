interface ProjectOwnerCandidate {
  id: string;
  organization_id: string;
}

/** Exact identity + tenant check for a caller-selected report owner. */
export function isValidCommerceReportOwner(
  candidate: ProjectOwnerCandidate | null,
  requestedProjectId: string,
  organizationId: string,
): boolean {
  return (
    candidate?.id === requestedProjectId &&
    candidate.organization_id === organizationId
  );
}
