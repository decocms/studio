/**
 * Stable pod identifier for the lifetime of this process.
 * In Kubernetes, set POD_NAME via the downward API (metadata.name).
 * Outside Kubernetes, each process gets a unique random UUID.
 *
 * Uses getSettings() which must be called after buildSettings() completes,
 * so this is exposed as a function rather than a module-level constant.
 */
import { getSettings } from "../settings";

export function getPodId(): string {
  return getSettings().podName;
}
