import type { InstallAppPatches } from "@decocms/shared/site-apps";

/**
 * The install an app's patches need from the pod, or null when they need none
 * (Deno: the `apps/` import-map alias covers every app).
 *
 * `force` only when the patch set rewrites `package.json`. The daemon's
 * install fingerprint is the package manager, the runtime and the branch HEAD,
 * so a manifest rewritten in the working tree is invisible to it and the step
 * would skip — but forcing when the manifest did NOT move tears down a healthy
 * dev server to reinstall an unchanged tree.
 *
 * The unforced request is still worth sending: it no-ops when the fingerprint
 * matches, and it is what recovers an earlier attempt whose install failed,
 * since a failure marks the fingerprint bad.
 */
export function dependencyInstallFor(
  patches: InstallAppPatches,
): { force: boolean } | null {
  if (!patches.dependency) return null;
  return {
    force: patches.files.some((file) => file.path === "package.json"),
  };
}

/**
 * Whether the pod still has to restart the dev server for these writes to
 * reach the site's schema.
 *
 * An app's form is generated from the app's own module, so it only exists
 * once the runtime re-reads the manifest — and nothing else makes it. A forced
 * install already tears the dev server down and brings it back; the other two
 * shapes never do: Deno sends no install at all, and an unforced install
 * no-ops whenever the fingerprint matches, even though `src/setup.ts` moved.
 *
 * A reinstall that wrote nothing needs no restart: that is the healthy dev
 * server this PR exists to stop tearing down.
 */
export function needsDevRestart(
  patches: InstallAppPatches,
  install: { force: boolean } | null,
): boolean {
  if (patches.files.length === 0) return false;
  return install?.force !== true;
}
