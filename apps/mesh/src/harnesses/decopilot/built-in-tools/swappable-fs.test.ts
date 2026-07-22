import { expect, test } from "bun:test";
import type { SandboxFsHooks } from "@decocms/harness/decopilot/built-in-tools/vm-tools/sandbox-fs-hooks-types";
import { createSwappableFs } from "./swappable-fs";

/** A stub fs whose every hook resolves a value tagged with `label`, so a test
 *  can tell which backing fs a call was routed to. */
function stubFs(label: string): SandboxFsHooks {
  return {
    onRead: async () => label,
    onWrite: async () => {},
    onEdit: async () => {},
    onBash: async () => ({ stdout: label, stderr: "", exitCode: 0 }),
    onGlob: async () => [label],
    onGrep: async () => [{ file: label, line: 1, text: label }],
    onProxy: async () => ({ label }),
  };
}

test("forwards calls to the initial fs before any swap", async () => {
  const { fs } = createSwappableFs(stubFs("old"));
  expect((await fs.onBash("ls")).stdout).toBe("old");
  expect(await fs.onRead("/x")).toBe("old");
});

test("swap re-points subsequent calls at the new fs", async () => {
  const { fs, swap } = createSwappableFs(stubFs("old"));
  const bash = fs.onBash; // capture the reference the way createVmTools does
  expect((await bash("ls")).stdout).toBe("old");

  swap(stubFs("new"));

  // The captured method reference now routes to the swapped-in fs — this is the
  // property that makes load_repo usable in the same turn.
  expect((await bash("ls")).stdout).toBe("new");
  expect(await fs.onGlob("**/*")).toEqual(["new"]);
});
