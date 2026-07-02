import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { purgeSandboxFiles } from "./purge-sandbox";

function sandboxWithVolumes(volumes: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "deco-purge-"));
  for (const v of volumes) {
    mkdirSync(join(root, "org", v), { recursive: true });
  }
  return root;
}

describe("purgeSandboxFiles", () => {
  it("detaches each direct child of org/ before removing the sandbox", async () => {
    const root = sandboxWithVolumes(["vol-a", "vol-b"]);
    const detached: string[] = [];
    const removed: string[] = [];

    await purgeSandboxFiles(root, {
      detach: (p) => detached.push(p),
      rm: (p) => {
        removed.push(p);
      },
    });

    expect(detached.sort()).toEqual(
      [join(root, "org", "vol-a"), join(root, "org", "vol-b")].sort(),
    );
    expect(removed).toEqual([root]);
  });

  it("removes the sandbox even when there is no org/ dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "deco-purge-"));
    const detached: string[] = [];
    const removed: string[] = [];

    await purgeSandboxFiles(root, {
      detach: (p) => detached.push(p),
      rm: (p) => {
        removed.push(p);
      },
    });

    expect(detached).toEqual([]);
    expect(removed).toEqual([root]);
  });
});
