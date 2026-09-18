/** One deployment-owned ID; no wildcard, slug lookup, or list semantics. */
export function parseDemoOrganizationId(
  value: string | undefined,
): string | undefined {
  const id = value?.trim();
  if (!id) return undefined;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
    throw new Error(
      "DEMO_ORGANIZATION_ID must contain one exact organization ID",
    );
  return id;
}

export function isConfiguredDemoOrganization(
  configured: string | undefined,
  organizationId: string,
): boolean {
  return Boolean(configured) && configured === organizationId;
}
