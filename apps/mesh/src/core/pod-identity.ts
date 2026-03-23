/**
 * Stable pod identifier for the lifetime of this process.
 * In Kubernetes, set POD_NAME via the downward API (metadata.name).
 * Outside Kubernetes, each process gets a unique random UUID.
 */
export const POD_ID = process.env.POD_NAME ?? crypto.randomUUID();
