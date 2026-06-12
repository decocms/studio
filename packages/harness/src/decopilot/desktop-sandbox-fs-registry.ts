import type { SandboxFsHooks } from "./built-in-tools/vm-tools/sandbox-fs-hooks-types";

/**
 * Desktop sandbox-fs builder registry.
 *
 * The portable desktop runtime needs flat `SandboxFsHooks` for its VM tools, but
 * the only impl (`buildDesktopSandboxFs`) is `@decocms/sandbox`-coupled — it owns
 * the local control-URL `SandboxProvider` + `createSandboxFsHooks`. To keep
 * `@decocms/harness` sandbox-free, the impl lives in `@decocms/sandbox`; the
 * daemon registers it here at boot and the runtime looks it up. Mirrors the
 * cluster/desktop environment-builder registration seam.
 */
export interface DesktopSandboxFsParams {
  virtualMcpId: string;
  branch?: string | null;
  userId?: string;
}
export type DesktopSandboxFsBuilder = (
  p: DesktopSandboxFsParams,
) => SandboxFsHooks;

let builder: DesktopSandboxFsBuilder | undefined;

export function registerDesktopSandboxFsBuilder(
  b: DesktopSandboxFsBuilder,
): void {
  builder = b;
}

export function getDesktopSandboxFsBuilder(): DesktopSandboxFsBuilder {
  if (!builder) {
    throw new Error(
      "[desktop] sandbox-fs builder not registered — the daemon must call " +
        "registerDesktopSandboxFsBuilder(buildDesktopSandboxFs) before dispatching",
    );
  }
  return builder;
}
