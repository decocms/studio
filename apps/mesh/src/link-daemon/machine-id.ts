/**
 * Machine-id is the stable identifier the link daemon presents at
 * registration. It lives at `<dataDir>/.deco/link/machine-id` and is
 * generated once per laptop.
 *
 * The cluster keys its `LinkRegistry` by the OAuth userSub, NOT by this
 * machineId — but it stores the value so it can detect "another machine
 * is already claiming this account" (409) and surface a hint to the user.
 *
 * 16 random bytes (32 hex chars). Generated lazily on first call.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function machineIdPath(dataDir: string): string {
  return join(dataDir, ".deco", "link", "machine-id");
}

export async function loadOrCreateMachineId(dataDir: string): Promise<string> {
  const path = machineIdPath(dataDir);
  try {
    const existing = await readFile(path, "utf8");
    const trimmed = existing.trim();
    if (trimmed) return trimmed;
  } catch {
    // fall through to create
  }
  const id = randomBytes(16).toString("hex");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, id);
  return id;
}
