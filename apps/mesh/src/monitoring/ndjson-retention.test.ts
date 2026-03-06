import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { cleanupOldMonitoringFiles } from "./ndjson-retention";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("cleanupOldMonitoringFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ndjson-retention-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should delete directories older than maxAgeDays", async () => {
    const old = new Date();
    old.setUTCDate(old.getUTCDate() - 31);
    const oldPath = join(
      tmpDir,
      String(old.getUTCFullYear()),
      String(old.getUTCMonth() + 1).padStart(2, "0"),
      String(old.getUTCDate()).padStart(2, "0"),
      "00",
    );
    await mkdir(oldPath, { recursive: true });
    await writeFile(join(oldPath, "test.ndjson"), "old-data");

    const now = new Date();
    const newPath = join(
      tmpDir,
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
      String(now.getUTCHours()).padStart(2, "0"),
    );
    await mkdir(newPath, { recursive: true });
    await writeFile(join(newPath, "test.ndjson"), "new-data");

    const deleted = await cleanupOldMonitoringFiles(tmpDir, { maxAgeDays: 30 });
    expect(deleted).toBeGreaterThanOrEqual(1);

    const allFiles = await readdir(tmpDir, { recursive: true });
    const ndjsonFiles = allFiles.filter((f) => f.endsWith(".ndjson"));
    expect(ndjsonFiles.length).toBe(1);
  });

  it("should handle missing base directory gracefully", async () => {
    const deleted = await cleanupOldMonitoringFiles("/nonexistent/path", {
      maxAgeDays: 30,
    });
    expect(deleted).toBe(0);
  });

  it("should handle year boundary correctly", async () => {
    const oldDate = new Date(Date.UTC(new Date().getUTCFullYear() - 1, 11, 1));
    const oldPath = join(
      tmpDir,
      String(oldDate.getUTCFullYear()),
      "12",
      "01",
      "00",
    );
    await mkdir(oldPath, { recursive: true });
    await writeFile(join(oldPath, "test.ndjson"), "old-data");

    const deleted = await cleanupOldMonitoringFiles(tmpDir, { maxAgeDays: 30 });
    expect(deleted).toBeGreaterThanOrEqual(1);
  });

  it("should ignore non-date directories", async () => {
    await mkdir(join(tmpDir, ".DS_Store"), { recursive: true });
    await mkdir(join(tmpDir, "tmp"), { recursive: true });

    const deleted = await cleanupOldMonitoringFiles(tmpDir, { maxAgeDays: 30 });
    expect(deleted).toBe(0);
  });

  it("should validate maxAgeDays is positive", async () => {
    const deleted = await cleanupOldMonitoringFiles(tmpDir, { maxAgeDays: -1 });
    expect(deleted).toBe(0);
  });

  it("should not delete directories within the retention cutoff boundary", async () => {
    const boundary = new Date();
    boundary.setUTCDate(boundary.getUTCDate() - 30);
    const boundaryPath = join(
      tmpDir,
      String(boundary.getUTCFullYear()),
      String(boundary.getUTCMonth() + 1).padStart(2, "0"),
      String(boundary.getUTCDate()).padStart(2, "0"),
      "00",
    );
    await mkdir(boundaryPath, { recursive: true });
    await writeFile(join(boundaryPath, "test.ndjson"), "boundary-data");

    const deleted = await cleanupOldMonitoringFiles(tmpDir, { maxAgeDays: 30 });
    expect(deleted).toBe(0);
  });
});
