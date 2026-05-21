import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateMachineId } from "./machine-id";

describe("machine-id", () => {
  it("creates a stable id on first call and reuses it on the second", async () => {
    const dir = mkdtempSync(join(tmpdir(), "link-test-"));
    try {
      const a = await loadOrCreateMachineId(dir);
      const b = await loadOrCreateMachineId(dir);
      expect(a).toBe(b);
      expect(a.length).toBe(32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
