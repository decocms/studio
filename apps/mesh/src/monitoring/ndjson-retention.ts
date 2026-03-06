import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export interface RetentionOptions {
  maxAgeDays: number;
}

export async function cleanupOldMonitoringFiles(
  basePath: string,
  options: RetentionOptions,
): Promise<number> {
  if (options.maxAgeDays <= 0) return 0;

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - options.maxAgeDays);
  cutoff.setUTCHours(0, 0, 0, 0);

  let deleted = 0;

  try {
    const years = await safeReaddir(basePath);
    for (const year of years) {
      if (!/^\d{4}$/.test(year)) continue;
      const yearPath = join(basePath, year);
      const months = await safeReaddir(yearPath);

      for (const month of months) {
        if (!/^\d{2}$/.test(month)) continue;
        const monthPath = join(yearPath, month);
        const days = await safeReaddir(monthPath);

        for (const day of days) {
          if (!/^\d{2}$/.test(day)) continue;
          const dirDate = new Date(`${year}-${month}-${day}T00:00:00Z`);
          if (isNaN(dirDate.getTime())) continue;

          if (dirDate < cutoff) {
            const dayPath = join(monthPath, day);
            await rm(dayPath, { recursive: true, force: true });
            deleted++;
          }
        }

        const remaining = await safeReaddir(monthPath);
        if (remaining.length === 0) {
          await rm(monthPath, { recursive: true, force: true });
        }
      }

      const remainingMonths = await safeReaddir(yearPath);
      if (remainingMonths.length === 0) {
        await rm(yearPath, { recursive: true, force: true });
      }
    }
  } catch {
    // Base path doesn't exist or isn't readable
  }

  return deleted;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => !e.startsWith("."));
  } catch {
    return [];
  }
}
