/**
 * Stable pod identifier for the lifetime of this process.
 * In Kubernetes, HOSTNAME is the pod name. In local dev, random UUID.
 */
export const POD_ID = process.env.HOSTNAME ?? crypto.randomUUID();
