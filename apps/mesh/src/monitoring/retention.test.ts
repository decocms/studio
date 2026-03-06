import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { cleanupOldParquetFiles } from "./retention";
import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("cleanupOldParquetFiles", () => {
  let basePath: string;

  beforeEach(async () => {
    basePath = join(tmpdir(), `retention-test-${Date.now()}`);
    await mkdir(basePath, { recursive: true });
  });

  afterEach(async () => {
    await rm(basePath, { recursive: true, force: true });
  });

  it("removes directories older than retention days", async () => {
    // Create old directory (40 days ago)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 40);
    const oldYear = oldDate.getUTCFullYear().toString();
    const oldMonth = (oldDate.getUTCMonth() + 1).toString().padStart(2, "0");
    const oldDay = oldDate.getUTCDate().toString().padStart(2, "0");
    const oldDir = join(basePath, oldYear, oldMonth, oldDay, "14");
    await mkdir(oldDir, { recursive: true });
    await writeFile(join(oldDir, "batch-000001.parquet"), "fake parquet data");

    // Create recent directory (today)
    const now = new Date();
    const newYear = now.getUTCFullYear().toString();
    const newMonth = (now.getUTCMonth() + 1).toString().padStart(2, "0");
    const newDay = now.getUTCDate().toString().padStart(2, "0");
    const newDir = join(basePath, newYear, newMonth, newDay, "10");
    await mkdir(newDir, { recursive: true });
    await writeFile(join(newDir, "batch-000001.parquet"), "fake parquet data");

    const deleted = await cleanupOldParquetFiles(basePath, 30);

    expect(deleted).toBe(1);

    const oldFiles = await safeReaddir(oldDir);
    expect(oldFiles.length).toBe(0);

    const newFiles = await safeReaddir(newDir);
    expect(newFiles.length).toBe(1);
  });

  it("does nothing when all files are recent", async () => {
    const now = new Date();
    const dir = join(
      basePath,
      now.getUTCFullYear().toString(),
      (now.getUTCMonth() + 1).toString().padStart(2, "0"),
      now.getUTCDate().toString().padStart(2, "0"),
      "10",
    );
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "batch-000001.parquet"), "data");

    const deleted = await cleanupOldParquetFiles(basePath, 30);
    expect(deleted).toBe(0);
  });

  it("handles empty base directory", async () => {
    const deleted = await cleanupOldParquetFiles(basePath, 30);
    expect(deleted).toBe(0);
  });

  it("handles non-existent base directory", async () => {
    const deleted = await cleanupOldParquetFiles(
      join(basePath, "nonexistent"),
      30,
    );
    expect(deleted).toBe(0);
  });
});

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
