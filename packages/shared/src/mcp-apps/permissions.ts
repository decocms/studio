import type { McpUiResourcePermissions } from "./types.ts";

/**
 * Response header carrying a UI resource's iframe `allow` value from the
 * cacheable GET path, where the resource `_meta` doesn't reach the client.
 */
export const MCP_APP_ALLOW_HEADER = "X-MCP-App-Allow";

const FEATURES: Record<keyof McpUiResourcePermissions, string> = {
  camera: "camera",
  microphone: "microphone",
  geolocation: "geolocation",
  clipboardWrite: "clipboard-write",
};

/**
 * The iframe `allow` attribute for the browser capabilities a UI resource
 * declares in `_meta.ui.permissions`. Only known features pass through, so a
 * resource can't smuggle arbitrary policy into the attribute. Empty when it
 * declares none — the frame then gets no extra capability.
 */
export function permissionsToAllow(permissions: unknown): string {
  if (!permissions || typeof permissions !== "object") return "";
  return Object.entries(FEATURES)
    .filter(([key]) => key in permissions)
    .map(([, feature]) => feature)
    .join("; ");
}
