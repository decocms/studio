/**
 * Delete a link sandbox directory from disk, unmounting any org-fs volumes
 * first so `rm` can't hang on a live (or ghost) NFS/FUSE mount nested at
 * `<sandboxPath>/org/<volume>`. All steps are injectable for tests.
 */
import { existsSync, readdirSync } from "node:fs";
import { rm as rmAsync } from "node:fs/promises";
import { join } from "node:path";
import { detachMount } from "@decocms/sandbox/org-fs/detach-mount";

export interface PurgeSandboxDeps {
  detach?: (mountPath: string) => void;
  exists?: (path: string) => boolean;
  readdir?: (dir: string) => string[];
  rm?: (path: string) => void | Promise<void>;
}

const defaultDetach = (mountPath: string): void =>
  detachMount(mountPath, process.platform === "darwin");

export async function purgeSandboxFiles(
  sandboxPath: string,
  deps: PurgeSandboxDeps = {},
): Promise<void> {
  const detach = deps.detach ?? defaultDetach;
  const exists = deps.exists ?? existsSync;
  const readdir = deps.readdir ?? ((dir) => readdirSync(dir));
  const rm =
    deps.rm ?? ((path) => rmAsync(path, { recursive: true, force: true }));

  const orgDir = join(sandboxPath, "org");
  if (exists(orgDir)) {
    for (const child of readdir(orgDir)) {
      detach(join(orgDir, child));
    }
  }
  await rm(sandboxPath);
}
