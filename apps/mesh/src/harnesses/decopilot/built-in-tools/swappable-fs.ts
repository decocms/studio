/**
 * A `SandboxFsHooks` whose backing target can be swapped at runtime.
 *
 * Why: the six VM file tools (read/write/edit/bash/grep/glob) are built ONCE
 * per run, closing over the fs hooks resolved from `vmContext.branch` at
 * run-start. When `load_repo` switches the thread's repo mid-run it provisions
 * a NEW sandbox on a new branch, but the already-built tools keep calling the
 * old (repo-less) fs — so `ls /app/repo` shows an empty checkout and the agent
 * loops waiting for files that live in a sandbox its tools aren't bound to.
 *
 * The tools instead call through this thin forwarder. `load_repo` calls `swap`
 * with the freshly-built fs after the clone lands, so the SAME turn's next
 * bash/read/glob hits the new sandbox — no "wait for the next message" contract.
 *
 * Pure: forwards every hook to the current target read at call time. No `@/` or
 * `@decocms/sandbox` imports, so it's trivially unit-testable.
 */

import type { SandboxFsHooks } from "@decocms/harness/decopilot/built-in-tools/vm-tools/sandbox-fs-hooks-types";

export interface SwappableFs {
  /** The forwarder to hand to `createVmTools` — a stable reference. */
  fs: SandboxFsHooks;
  /** Point the forwarder at a new backing fs (called by `load_repo`). */
  swap(next: SandboxFsHooks): void;
}

export function createSwappableFs(initial: SandboxFsHooks): SwappableFs {
  let current = initial;
  const fs: SandboxFsHooks = {
    onRead: (path) => current.onRead(path),
    onWrite: (path, content) => current.onWrite(path, content),
    onEdit: (path, edits) => current.onEdit(path, edits),
    onBash: (cmd, opts) => current.onBash(cmd, opts),
    onGlob: (pattern) => current.onGlob(pattern),
    onGrep: (pattern, opts) => current.onGrep(pattern, opts),
    onProxy: (path, body, method, signal) =>
      current.onProxy(path, body, method, signal),
  };
  return {
    fs,
    swap(next) {
      current = next;
    },
  };
}
