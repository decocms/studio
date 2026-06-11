/**
 * Per-run thread links into the hidden per-thread volumes:
 *   - `<appRoot>/org/output` → `.outputs/<threadId>` — share files back
 *   - `<appRoot>/org/upload` → `.uploads/<threadId>` — chat attachments in
 *
 * Each volume is mounted (hidden) at `<appRoot>/org/.<name>`; each run gets a
 * thread-scoped subdir, so an agent touching the bare link path lands in that
 * thread's subtree of the org-wide volume. Repointed per dispatch; concurrent
 * runs in one sandbox share the link (last dispatch wins). Link targets are
 * relative so the tree survives being moved.
 *
 * All fs ops are async: the daemon serves the mount's WebDAV layer in-process,
 * so a synchronous touch of its own mount would deadlock the event loop
 * (kernel waits on rclone → rclone waits on WebDAV → WebDAV waits on the
 * blocked event loop). Never throws.
 */

import { lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";

/** One path segment, no traversal — threadIds are cluster-issued slugs/UUIDs. */
const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface ThreadLinkSpec {
  /** Hidden mount dir under `org/` (e.g. ".outputs"). */
  mountDir: string;
  /** Bare link name under `org/` (e.g. "output"). */
  linkName: string;
}

async function repointThreadLink(
  appRoot: string,
  threadId: string,
  spec: ThreadLinkSpec,
  log: (msg: string, err?: unknown) => void = () => {},
): Promise<boolean> {
  try {
    if (!SAFE_THREAD_ID.test(threadId)) {
      log(
        `${spec.linkName} link skipped: unsafe threadId ${JSON.stringify(threadId)}`,
      );
      return false;
    }
    const orgRoot = join(appRoot, "org");
    const volumeMount = join(orgRoot, spec.mountDir);
    // Defense-in-depth (the caller already gates on the live mount): without
    // the mount, mkdir would silently create local dirs that shadow it later.
    const mountStat = await lstat(volumeMount).catch(() => null);
    if (!mountStat?.isDirectory()) return false;

    // The thread's subtree in the volume (created through the mount).
    await mkdir(join(volumeMount, threadId), { recursive: true });

    const link = join(orgRoot, spec.linkName);
    const target = join(spec.mountDir, threadId);
    const cur = await lstat(link).catch(() => null);
    if (cur) {
      if (!cur.isSymbolicLink()) {
        log(
          `${spec.linkName} link skipped: ${link} exists and is not a symlink`,
        );
        return false;
      }
      if ((await readlink(link).catch(() => null)) === target) return true;
      await unlink(link);
    }
    await symlink(target, link);
    return true;
  } catch (err) {
    log(`${spec.linkName} link repoint failed`, err);
    return false;
  }
}

export function repointOutputLink(
  appRoot: string,
  threadId: string,
  log?: (msg: string, err?: unknown) => void,
): Promise<boolean> {
  return repointThreadLink(
    appRoot,
    threadId,
    { mountDir: ".outputs", linkName: "output" },
    log,
  );
}

export function repointUploadLink(
  appRoot: string,
  threadId: string,
  log?: (msg: string, err?: unknown) => void,
): Promise<boolean> {
  return repointThreadLink(
    appRoot,
    threadId,
    { mountDir: ".uploads", linkName: "upload" },
    log,
  );
}
