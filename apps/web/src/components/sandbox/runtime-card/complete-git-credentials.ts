import {
  SUBMODULE_HOST_RE,
  type SubmoduleCredential,
} from "@decocms/shared/organization/schema";

/** The server lowercases a host; comparing rows has to see what it will. */
export function normalizeGitHost(host: string): string {
  return host.trim().toLowerCase();
}

function isComplete(row: SubmoduleCredential): boolean {
  return (
    SUBMODULE_HOST_RE.test(normalizeGitHost(row.host)) &&
    row.secretId.length > 0
  );
}

/**
 * Whether a finished row above already claims this row's host. Only finished
 * rows count: a half-typed one is not saved, so it claims nothing.
 */
export function repeatsEarlierGitHost(
  rows: SubmoduleCredential[],
  index: number,
): boolean {
  const host = normalizeGitHost(rows[index]?.host ?? "");
  return (
    host.length > 0 &&
    rows
      .slice(0, index)
      .some((row) => isComplete(row) && normalizeGitHost(row.host) === host)
  );
}

/**
 * The rows the server schema accepts: a well-formed host, a picked secret, and
 * no host listed twice (the first finished row keeps it). The rest stay in
 * form state so the user can finish them, and out of the autosave payload so a
 * half-typed row is not a validation error on every keystroke.
 */
export function completeGitCredentials(
  rows: SubmoduleCredential[],
): SubmoduleCredential[] {
  return rows
    .filter(
      (row, index) => isComplete(row) && !repeatsEarlierGitHost(rows, index),
    )
    .map((row) => ({ ...row, host: normalizeGitHost(row.host) }));
}
