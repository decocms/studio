/**
 * Ensures a pinned `rclone` binary (with mount support) is available on the
 * user's machine for the org-fs mount, downloading + caching it under the link
 * daemon's data dir on first use. The official rclone.org build is required —
 * Homebrew's notably ships without `mount`. Returns the binary path, or null
 * if unavailable (the daemon then simply skips mounting).
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const RCLONE_VERSION = "v1.74.3";

/** rclone.org release slug for the current platform, or null if unsupported. */
function platformSlug(): string | null {
  const os =
    process.platform === "darwin"
      ? "osx"
      : process.platform === "linux"
        ? "linux"
        : null;
  const arch =
    process.arch === "arm64"
      ? "arm64"
      : process.arch === "x64"
        ? "amd64"
        : null;
  return os && arch ? `${os}-${arch}` : null;
}

export async function ensureRclone(dataDir: string): Promise<string | null> {
  const slug = platformSlug();
  if (!slug) return null;
  const name = `rclone-${RCLONE_VERSION}-${slug}`;
  const dir = join(dataDir, "cache", name);
  const bin = join(dir, "rclone");
  if (existsSync(bin)) return bin;

  try {
    mkdirSync(dir, { recursive: true });
    const url = `https://downloads.rclone.org/${RCLONE_VERSION}/${name}.zip`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const zip = join(dir, "rclone.zip");
    await Bun.write(zip, await res.arrayBuffer());
    // The archive nests the binary under `<name>/rclone`; `-j` flattens it
    // into `dir`, `-o` overwrites a partial prior attempt.
    const unzip = Bun.spawnSync([
      "unzip",
      "-o",
      "-j",
      zip,
      `${name}/rclone`,
      "-d",
      dir,
    ]);
    if (unzip.exitCode !== 0 || !existsSync(bin)) {
      throw new Error("unzip failed (is `unzip` installed?)");
    }
    Bun.spawnSync(["chmod", "+x", bin]);
    return bin;
  } catch (err) {
    console.warn(
      "[org-fs] rclone unavailable; volume mounting disabled for this machine",
      err,
    );
    return null;
  }
}
