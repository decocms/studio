/**
 * agent-sandbox CRD identifiers + error classes. Pinned verbatim from
 * kubernetes-sigs/agent-sandbox via deco-cx/admin/clients/agent-sandbox/types.ts.
 * When the operator widens to a new API version, change here once — every
 * call site reads through these constants.
 */

export const K8S_CONSTANTS = {
  CLAIM_API_GROUP: "extensions.agents.x-k8s.io",
  CLAIM_API_VERSION: "v1alpha1",
  CLAIM_PLURAL: "sandboxclaims",

  SANDBOX_API_GROUP: "agents.x-k8s.io",
  SANDBOX_API_VERSION: "v1alpha1",
  SANDBOX_PLURAL: "sandboxes",

  POD_NAME_ANNOTATION: "agents.x-k8s.io/pod-name",
} as const;

export class SandboxError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SandboxError";
    this.cause = cause;
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

export class SandboxTimeoutError extends SandboxError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "SandboxTimeoutError";
  }
}

/**
 * Surfaced when the API server rejects a SandboxClaim create with 409
 * AlreadyExists — typically because the operator's idle-TTL deletion of a
 * prior claim is still draining finalizers when mesh tries to recreate.
 * Callers wait for the resource to fully disappear and retry.
 */
export class SandboxAlreadyExistsError extends SandboxError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "SandboxAlreadyExistsError";
  }
}
