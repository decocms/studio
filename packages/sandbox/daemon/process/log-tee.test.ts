import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogTee } from "./log-tee";

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "log-tee-test-"));
  return join(dir, "app-name");
}

describe("LogTee", () => {
  it("rotates on the very first write when reopening a path already near the cap", () => {
    // Regression: named-script tees reopen the same path across runs. A
    // fresh LogTee instance starts with `written = 0` until it stats the
    // file — the overflow check must not fire against that stale zero.
    const path = tmpPath();
    writeFileSync(path, "x".repeat(95));
    const tee = new LogTee(path, 100);
    tee.write("y".repeat(20));
    tee.close();

    expect(tee.isTruncated()).toBe(true);
    expect(statSync(path).size).toBeLessThanOrEqual(100);
    expect(readFileSync(path, "utf-8")).toContain("y".repeat(20));
  });

  it("does not rotate when reopening a path that still has headroom", () => {
    const path = tmpPath();
    writeFileSync(path, "x".repeat(50));
    const tee = new LogTee(path, 100);
    tee.write("y".repeat(20));
    tee.close();

    expect(tee.isTruncated()).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(
      `${"x".repeat(50)}${"y".repeat(20)}`,
    );
  });
});
