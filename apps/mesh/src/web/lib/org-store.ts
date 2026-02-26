/**
 * Per-tab org ID store.
 *
 * Browser tabs each have their own JS execution context, so module-level state
 * is naturally isolated per tab. We use this to track the org the current tab
 * is operating in, so the auth client can inject it on every outbound request
 * rather than relying on the shared server-side session's activeOrganizationId.
 */
let currentOrgId: string | null = null;

export function setCurrentOrgId(id: string | null): void {
  currentOrgId = id;
}

export function getCurrentOrgId(): string | null {
  return currentOrgId;
}
