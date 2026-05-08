import { createHash } from "node:crypto";
import type { TenantConfig } from "../types";

/**
 * What we've installed against, reflected in memory only. On daemon
 * restart this resets to null and the orchestrator's resume path will
 * trigger a reinstall — that's the conservative default in v1.
 */
export interface InstallSnapshot {
  fingerprint: string;
  ok: boolean;
  installedAt: number;
}

export class InstallState {
  private snapshot: InstallSnapshot | null = null;

  current(): InstallSnapshot | null {
    return this.snapshot;
  }

  /**
   * Compute the fingerprint of the install-relevant slice of config plus
   * the current branch HEAD. The orchestrator passes the resolved branch
   * sha (or undefined when there is no repo).
   */
  static fingerprint(
    config: TenantConfig,
    branchHead: string | undefined,
  ): string {
    const slice = {
      pm: config.application?.packageManager?.name,
      pmPath: config.application?.packageManager?.path,
      runtime: config.application?.runtime,
      branchHead: branchHead ?? null,
    };
    return createHash("sha256")
      .update(JSON.stringify(slice))
      .digest("hex")
      .slice(0, 16);
  }

  mark(fingerprint: string, ok: boolean): void {
    this.snapshot = { fingerprint, ok, installedAt: Date.now() };
  }

  isInstalledFor(
    config: TenantConfig,
    branchHead: string | undefined,
  ): boolean {
    if (!this.snapshot || !this.snapshot.ok) return false;
    return (
      this.snapshot.fingerprint === InstallState.fingerprint(config, branchHead)
    );
  }

  clear(): void {
    this.snapshot = null;
  }
}
