/**
 * SandboxStore — public surface.
 *
 * `pickStoreFromEnv()` returns the right adapter for the runtime:
 *   - `SANDBOX_SNAPSHOTS_BUCKET` set → S3Store (prod / IRSA cluster)
 *   - otherwise                     → LocalFsStore under <DATA_DIR>/sandbox-snapshots
 *
 * S3Store lands in a follow-up step; for now the picker returns LocalFsStore
 * unconditionally so step 1 can ship without touching prod wiring.
 */

import { join } from "node:path";

import { LocalFsStore } from "./local-fs-store";
import type { SandboxStore } from "./types";

export type { SandboxStore, SandboxSnapshotKey, SnapshotHead } from "./types";
export { snapshotKey } from "./types";
export { LocalFsStore } from "./local-fs-store";

export interface PickStoreOptions {
  /** `<DATA_DIR>` from settings — root for `LocalFsStore`. */
  dataDir: string;
  /** S3 bucket name; when set, `S3Store` is selected. */
  bucket?: string | undefined;
}

export function pickStoreFromEnv(opts: PickStoreOptions): SandboxStore {
  // S3 adapter is introduced in a later step; until then any deploy that
  // wants persistence runs against the local filesystem. The picker shape
  // is in place so swapping in S3Store doesn't ripple through callers.
  if (opts.bucket) {
    throw new Error(
      "pickStoreFromEnv: S3Store not yet implemented; unset SANDBOX_SNAPSHOTS_BUCKET to use LocalFsStore",
    );
  }
  return new LocalFsStore(join(opts.dataDir, "sandbox-snapshots"));
}
