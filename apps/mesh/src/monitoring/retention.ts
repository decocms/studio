import { readdir, rm, rmdir, lstat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Clean up Parquet files older than the specified retention period.
 *
 * Walks the time-partitioned directory structure (YYYY/MM/DD/HH/)
 * and removes files whose directory date is older than `retentionDays`.
 * Also cleans up empty parent directories after deletion.
 *
 * @param basePath - Base monitoring directory (e.g., ./data/monitoring)
 * @param retentionDays - Number of days to keep (default: 30)
 * @returns Number of files deleted
 */
export async function cleanupOldParquetFiles(
  basePath: string,
  retentionDays: number = 30,
): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  cutoff.setHours(0, 0, 0, 0);

  let deletedCount = 0;

  const years = await safeReaddir(basePath);
  for (const year of years) {
    const yearPath = join(basePath, year);
    if (!(await isDirectory(yearPath))) continue;

    const months = await safeReaddir(yearPath);
    for (const month of months) {
      const monthPath = join(yearPath, month);
      if (!(await isDirectory(monthPath))) continue;

      const days = await safeReaddir(monthPath);
      for (const day of days) {
        const dayPath = join(monthPath, day);
        if (!(await isDirectory(dayPath))) continue;

        const dirDate = new Date(
          Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day)),
        );
        if (isNaN(dirDate.getTime())) continue;

        if (dirDate < cutoff) {
          const hours = await safeReaddir(dayPath);
          for (const hour of hours) {
            const hourPath = join(dayPath, hour);
            if (!(await isDirectory(hourPath))) continue;

            const files = await safeReaddir(hourPath);
            for (const file of files) {
              if (file.endsWith(".parquet")) {
                await rm(join(hourPath, file));
                deletedCount++;
              }
            }

            await tryRmdir(hourPath);
          }

          await tryRmdir(dayPath);
        }
      }

      await tryRmdir(monthPath);
    }

    await tryRmdir(yearPath);
  }

  return deletedCount;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await lstat(path);
    return s.isDirectory() && !s.isSymbolicLink();
  } catch {
    return false;
  }
}

async function tryRmdir(path: string): Promise<void> {
  try {
    const entries = await readdir(path);
    if (entries.length === 0) {
      await rmdir(path);
    }
  } catch {
    // Ignore errors
  }
}
