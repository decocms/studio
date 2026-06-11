/**
 * Per-run "share files back" link: `<appRoot>/org/output` → `.outputs/<threadId>`.
 *
 * The outputs volume is mounted (hidden) at `<appRoot>/org/.outputs`; each run
 * gets a thread-scoped subdir, so an agent writing to the bare `output/` path
 * lands its files in that thread's subtree of the org-wide volume. Repointed
 * per dispatch; concurrent runs in one sandbox share the link (last dispatch
 * wins). The link target is relative so the tree survives being moved.
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

export async function repointOutputLink(
  appRoot: string,
  threadId: string,
  log: (msg: string, err?: unknown) => void = () => {},
): Promise<boolean> {
  try {
    if (!SAFE_THREAD_ID.test(threadId)) {
      log(`output link skipped: unsafe threadId ${JSON.stringify(threadId)}`);
      return false;
    }
    const orgRoot = join(appRoot, "org");
    const outputsMount = join(orgRoot, ".outputs");
    // Defense-in-depth (the caller already gates on the live mount): without
    // the mount, mkdir would silently create local dirs that shadow it later.
    const mountStat = await lstat(outputsMount).catch(() => null);
    if (!mountStat?.isDirectory()) return false;

    // The thread's subtree in the outputs volume (created through the mount).
    await mkdir(join(outputsMount, threadId), { recursive: true });

    const link = join(orgRoot, "output");
    const target = join(".outputs", threadId);
    const cur = await lstat(link).catch(() => null);
    if (cur) {
      if (!cur.isSymbolicLink()) {
        log(`output link skipped: ${link} exists and is not a symlink`);
        return false;
      }
      if ((await readlink(link).catch(() => null)) === target) return true;
      await unlink(link);
    }
    await symlink(target, link);
    return true;
  } catch (err) {
    log("output link repoint failed", err);
    return false;
  }
}
