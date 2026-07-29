/**
 * POST /_sandbox/orgfs-config — receive the org-fs mount config post-bind.
 *
 * Cluster pods can't get ORGFS_CONFIG as boot env (warm-pool claims reject
 * `spec.env`), and TenantConfig is the wrong vehicle (an orgFs-only patch
 * classifies as no-op and is dropped). So the studio runner POSTs it here right
 * after `/config`, and the daemon relays it to the privileged org-fs sidecar
 * by writing a file on the shared control volume — the sidecar (which does
 * the actual mounting; this container can't) is watching for it.
 *
 * Inert outside cluster pods: when `ORGFS_SIDECAR_CONFIG_PATH` is unset the
 * handler answers `{ written: false }` and touches nothing. Desktop links
 * keep their boot-env path.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseOrgFsConfig } from "../org-fs/config";
import { jsonResponse } from "./body-parser";

export function makeOrgFsConfigHandler(opts: {
  /** Shared-volume file the sidecar watches; unset = relay disabled. */
  configPath: string | undefined;
  log?: (msg: string, err?: unknown) => void;
}): (req: Request) => Promise<Response> {
  const log = opts.log ?? ((m, e) => console.warn(`[org-fs] ${m}`, e ?? ""));
  return async (req) => {
    const raw = await req.text();
    if (!parseOrgFsConfig(raw)) {
      return jsonResponse({ error: "invalid org-fs config" }, 400);
    }
    if (!opts.configPath) return jsonResponse({ written: false });
    try {
      // Atomic write: the sidecar must never read a torn file.
      await mkdir(dirname(opts.configPath), { recursive: true });
      const tmp = join(dirname(opts.configPath), `.config-${process.pid}.tmp`);
      await writeFile(tmp, raw);
      await rename(tmp, opts.configPath);
      return jsonResponse({ written: true });
    } catch (err) {
      log("sidecar config relay failed", err);
      return jsonResponse({ error: "relay failed" }, 500);
    }
  };
}
