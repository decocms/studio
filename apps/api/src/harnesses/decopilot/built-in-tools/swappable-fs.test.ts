import { expect, test } from "bun:test";
import type { SandboxFsHooks } from "@/harnesses/lib/decopilot/built-in-tools/vm-tools/sandbox-fs-hooks-types";
import { createSwappableFs } from "./swappable-fs";

/** A stub whose hooks return `label` so tests can identify their target. */
function stubFs(label: string): SandboxFsHooks {
  return {
    onBash: async () => ({ stdout: label, stderr: "", exitCode: 0 }),
    onProxy: async () => ({ label }),
  };
}

test("forwards calls to the initial fs before any swap", async () => {
  const { fs } = createSwappableFs(stubFs("old"));
  expect((await fs.onBash("ls")).stdout).toBe("old");
  expect(await fs.onProxy("/_sandbox/read", { path: "/x" })).toEqual({
    label: "old",
  });
});

test("swap re-points subsequent calls at the new fs", async () => {
  const { fs, swap } = createSwappableFs(stubFs("old"));
  const bash = fs.onBash; // capture the reference the way createVmTools does
  expect((await bash("ls")).stdout).toBe("old");

  swap(stubFs("new"));

  // The captured method reference now routes to the swapped-in fs — this is the
  // property that makes load_repo usable in the same turn.
  expect((await bash("ls")).stdout).toBe("new");
  expect(await fs.onProxy("/_sandbox/glob", { pattern: "**/*" })).toEqual({
    label: "new",
  });
});
