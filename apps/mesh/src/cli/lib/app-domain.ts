import { createHash } from "node:crypto";

/**
 * Stable subdomain for a user's tunnel of a given app.
 * `principal` is typically the OAuth `sub`; `app` the project name.
 * Algorithm matches the legacy `getAppUUID` (sha1, despite its name)
 * so existing tunnel registrations remain valid.
 */
export function computeAppHash(principal: string, app: string): string {
  return createHash("sha1")
    .update(`${principal}-${app}`)
    .digest("hex")
    .slice(0, 8);
}

export function computeAppDomain(principal: string, app: string): string {
  return `localhost-${computeAppHash(principal, app)}.deco.host`;
}
