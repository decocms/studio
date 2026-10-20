/**
 * Distinguishes "the MCP Studio backend isn't provisioned for this
 * deployment" (the `AUTOMATION_LIST` query hits a Postgres relation that was
 * never migrated, e.g. `workflow_collection`) from any other failure — an
 * expired session, a permission error, a transient 500. Pure and testable
 * without mounting the component.
 *
 * Only the missing-relation case gets the "go to setup" empty state; every
 * other error must still surface as an error, not a misleading setup prompt.
 */
export function isAutomationsNotConfiguredError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("relation") && msg.includes("does not exist");
}
