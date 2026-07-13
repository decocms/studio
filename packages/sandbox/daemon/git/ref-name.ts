/** Git branch/ref segment safe for `git fetch origin <name>` (no flag injection). */
const REMOTE_BRANCH_NAME = /^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/;

export class InvalidRemoteBranchNameError extends Error {
  constructor(name: string) {
    super(`Invalid base branch name: ${name}`);
    this.name = "InvalidRemoteBranchNameError";
  }
}

/** Whether `name` is safe to interpolate as a git CLI branch/ref argument. */
export function isValidRemoteBranchName(name: string): boolean {
  return (
    !!name &&
    name.length <= 255 &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    REMOTE_BRANCH_NAME.test(name)
  );
}

/** Validates a remote branch name before passing it as a git CLI argument. */
export function assertValidRemoteBranchName(name: string): void {
  if (!isValidRemoteBranchName(name)) {
    throw new InvalidRemoteBranchNameError(name);
  }
}
