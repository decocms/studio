/**
 * SandboxStore — public surface.
 *
 * `pickStoreFromEnv()` returns the right adapter for the runtime:
 *   - `SANDBOX_SNAPSHOTS_BUCKET` set → `S3Store` (prod / IRSA cluster)
 *   - otherwise                     → `LocalFsStore` under
 *                                     `<DATA_DIR>/sandbox-snapshots`
 *
 * Region/prefix/endpoint are read from env so callers don't need to
 * thread them through. See SANDBOX_PERSISTENCE.md for the helm wiring.
 */

import { join } from "node:path";

import { LocalFsStore } from "./local-fs-store";
import { S3Store } from "./s3-store";
import type { SandboxStore } from "./types";

export type { SandboxStore, SandboxSnapshotKey, SnapshotHead } from "./types";
export { snapshotKey } from "./types";
export { LocalFsStore } from "./local-fs-store";
export { S3Store } from "./s3-store";

export function pickStoreFromEnv({
  dataDir,
}: {
  dataDir: string;
}): SandboxStore {
  const bucket = process.env.SANDBOX_SNAPSHOTS_BUCKET;
  if (bucket) {
    return new S3Store({
      bucket,
      region: process.env.SANDBOX_SNAPSHOTS_REGION,
      prefix: process.env.SANDBOX_SNAPSHOTS_PREFIX ?? "sandbox-snapshots",
      endpoint: process.env.SANDBOX_SNAPSHOTS_ENDPOINT,
      forcePathStyle: process.env.SANDBOX_SNAPSHOTS_FORCE_PATH_STYLE === "1",
    });
  }
  return new LocalFsStore(join(dataDir, "sandbox-snapshots"));
}
