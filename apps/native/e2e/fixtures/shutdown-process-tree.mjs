/**
 * TERM-resistant process tree for shutdown-lifecycle.e2e.test.ts.
 *
 * The local-api test starts `root` through `POST /_sandbox/bash` with the
 * shell replaced via `exec`. The bash route joins that shell to an independent
 * watchdog-owned process group, so root, child, and grandchild must all remain
 * in the watchdog's group (whose PGID deliberately differs from root's PID).
 * Every generation ignores SIGTERM after recording it; local-api therefore has
 * to escalate to SIGKILL and reap the complete group during shutdown.
 *
 * Keep the unique ownership marker in every argv. The test's leak cleanup
 * checks that marker before ever signalling a retained pid, protecting against
 * pid reuse after the original fixture has already exited.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [role, ownership, pidDir] = process.argv.slice(2);
const nextRole = { root: "child", child: "grandchild" }[role];

if (
  !role ||
  !ownership ||
  !pidDir ||
  !["root", "child", "grandchild"].includes(role)
) {
  process.stderr.write(
    "usage: shutdown-process-tree.mjs <root|child|grandchild> <ownership> <pid-dir>\n",
  );
  process.exit(2);
}

mkdirSync(pidDir, { recursive: true, mode: 0o700 });

process.on("SIGTERM", () => {
  appendFileSync(join(pidDir, `${role}.term`), `${Date.now()}\n`, {
    mode: 0o600,
  });
  // Deliberately remain alive. Graceful local-api shutdown must escalate the
  // whole process group to SIGKILL instead of mistaking delivery for reap.
});

writeFileSync(join(pidDir, `${role}.pid`), `${process.pid}\n`, {
  mode: 0o600,
});

if (nextRole) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), nextRole, ownership, pidDir],
    {
      detached: false,
      stdio: "ignore",
    },
  );
  child.on("error", (error) => {
    writeFileSync(join(pidDir, `${role}.spawn-error`), String(error), {
      mode: 0o600,
    });
    process.exit(3);
  });
}

// No extra `sleep` subprocess: the three recorded pids are the complete tree,
// so the black-box test can prove (and, on regression, safely clean) every
// process created by this fixture.
setInterval(() => {}, 60_000);
