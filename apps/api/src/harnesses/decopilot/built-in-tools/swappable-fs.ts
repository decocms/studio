/**
 * A `SandboxFsHooks` whose backing target can be swapped at runtime.
 *
 * Why: VM tools are built once per run, closing over hooks resolved from
 * `vmContext.branch` at run-start. When `load_repo` switches the thread's repo
 * mid-run it provisions a new sandbox on a new branch, but the already-built
 * tools would otherwise keep calling the old sandbox.
 *
 * The tools instead call through this thin forwarder. `load_repo` calls `swap`
 * with the freshly-built fs after the clone lands, so the SAME turn's next
 * daemon call hits the new sandbox — no "wait for the next message" contract.
 *
 * Pure: forwards every hook to the current target read at call time. No `@/` or
 * `@decocms/sandbox` imports, so it's trivially unit-testable.
 */

import type { SandboxFsHooks } from "@/harnesses/lib/decopilot/built-in-tools/vm-tools/sandbox-fs-hooks-types";

export interface SwappableFs {
  /** The forwarder to hand to `createVmTools` — a stable reference. */
  fs: SandboxFsHooks;
  /** Point the forwarder at a new backing fs (called by `load_repo`). */
  swap(next: SandboxFsHooks): void;
}

export function createSwappableFs(initial: SandboxFsHooks): SwappableFs {
  let current = initial;
  const fs: SandboxFsHooks = {
    onBash: (cmd, opts) => current.onBash(cmd, opts),
    onProxy: (path, body, signal) => current.onProxy(path, body, signal),
  };
  return {
    fs,
    swap(next) {
      current = next;
    },
  };
}
