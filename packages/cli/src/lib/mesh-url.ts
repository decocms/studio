/**
 * Mesh URL resolution: probe localhost:3000 first, fall back to studio.decocms.com.
 * No caching — probes on every call so switching between local and cloud is seamless.
 */

const LOCAL_MESH_URL = "http://localhost:3000";
const CLOUD_MESH_URL = "https://studio.decocms.com";

/**
 * Resolve the Mesh instance URL.
 *
 * - If `override` is provided (e.g. via --mesh-url flag), return it directly.
 * - Otherwise, probe http://localhost:3000/health with a 1-second timeout.
 *   If Mesh responds with a 2xx status, return the local URL.
 * - Fall back to https://studio.decocms.com.
 */
export async function resolveMeshUrl(override?: string): Promise<string> {
  if (override) {
    return override;
  }

  try {
    const res = await fetch(`${LOCAL_MESH_URL}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      return LOCAL_MESH_URL;
    }
  } catch {
    // Probe failed — fall through to cloud URL
  }

  return CLOUD_MESH_URL;
}
