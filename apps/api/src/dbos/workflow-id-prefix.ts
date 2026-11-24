import { DBOS } from "@dbos-inc/dbos-sdk";
import type { GetWorkflowsInput, WorkflowStatus } from "@dbos-inc/dbos-sdk";

/**
 * DBOS turns `workflow_id_prefix` into `workflow_uuid LIKE '<prefix>%'`
 * without escaping, and our prefixes embed caller-chosen ids (thread ids). A
 * `%` or `_` in such an id would match other tenants' workflows.
 */
export function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, "\\$&");
}

export function keepLiteralIdPrefix(
  rows: WorkflowStatus[],
  prefix: string,
): WorkflowStatus[] {
  return rows.filter((row) => row.workflowID.startsWith(prefix));
}

/**
 * List workflows whose id starts with `prefix` literally. Escaping keeps the
 * SQL scan narrow; the re-filter is the guard if escaping ever differs.
 */
export async function listWorkflowsByIdPrefix(
  prefix: string,
  input: Omit<GetWorkflowsInput, "workflow_id_prefix">,
): Promise<WorkflowStatus[]> {
  const rows = await DBOS.listWorkflows({
    ...input,
    workflow_id_prefix: escapeLikePrefix(prefix),
  });
  return keepLiteralIdPrefix(rows, prefix);
}
