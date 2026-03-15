/**
 * PGlite Auto-Repair & Rolling Backups
 *
 * On healthy startup: creates a rolling backup (keeps last 2 known-good states).
 * On corruption: attempts progressive recovery:
 *   1. Clear WAL + transient state (preserves table data)
 *   2. Restore from most recent rolling backup
 *   3. Nuke and recreate (migrations rebuild schema)
 */

import {
  cpSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "fs";
import * as path from "path";
import { PGlite } from "@electric-sql/pglite";
import { env } from "../env";
import { clearStalePGliteLock, extractPGlitePath } from "./index";

// ============================================================================
// Path helpers
// ============================================================================

function parsePGlitePath(): string | null {
  const url = env.DATABASE_URL;
  if (!url || url === ":memory:") return null;

  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return null;
  }

  return extractPGlitePath(url);
}

// ============================================================================
// Rolling backup system — keeps 2 most recent known-good snapshots
// ============================================================================

const MAX_BACKUPS = 2;

/** Return the backup directory for a given data dir (sibling directory). */
function backupDir(dataDir: string): string {
  return `${dataDir}.backups`;
}

/**
 * Create a rolling backup of a healthy PGlite data directory.
 *
 * Rotates existing backups so only the last `MAX_BACKUPS` are kept:
 *   backup-1/ (newest) → backup-2/ (oldest)
 *   current snapshot   → backup-1/
 */
export function createRollingBackup(dataDir: string): void {
  const backups = backupDir(dataDir);

  // Rotate: delete oldest, shift others down
  const oldest = path.join(backups, `backup-${MAX_BACKUPS}`);
  if (existsSync(oldest)) {
    rmSync(oldest, { recursive: true, force: true });
  }

  for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
    const src = path.join(backups, `backup-${i}`);
    const dst = path.join(backups, `backup-${i + 1}`);
    if (existsSync(src)) {
      renameSync(src, dst);
    }
  }

  // Copy current data → backup-1
  const target = path.join(backups, "backup-1");
  try {
    cpSync(dataDir, target, { recursive: true });
    // Remove the postmaster.pid from the backup (it's always stale)
    const backupPid = path.join(target, "postmaster.pid");
    if (existsSync(backupPid)) rmSync(backupPid, { force: true });
    console.log(`📦 PGlite backup created: ${target}`);
  } catch (err) {
    console.warn("⚠️  Failed to create PGlite backup:", err);
  }
}

/**
 * Try to restore from the most recent valid rolling backup.
 * Returns true if a backup was restored, false if none available.
 */
function restoreFromBackup(dataDir: string): boolean {
  const backups = backupDir(dataDir);
  if (!existsSync(backups)) return false;

  for (let i = 1; i <= MAX_BACKUPS; i++) {
    const candidate = path.join(backups, `backup-${i}`);
    if (!existsSync(candidate)) continue;

    // Basic sanity: must have PG_VERSION and base/
    if (
      !existsSync(path.join(candidate, "PG_VERSION")) ||
      !existsSync(path.join(candidate, "base"))
    ) {
      continue;
    }

    console.warn(`  Restoring from backup-${i}...`);
    try {
      rmSync(dataDir, { recursive: true, force: true });
      cpSync(candidate, dataDir, { recursive: true });
      // Remove pid from restored copy
      const restoredPid = path.join(dataDir, "postmaster.pid");
      if (existsSync(restoredPid)) rmSync(restoredPid, { force: true });

      const backupStat = statSync(candidate);
      const age = Math.round((Date.now() - backupStat.mtimeMs) / 1000 / 60);
      console.warn(`  Restored backup-${i} (${age} minutes old)`);
      return true;
    } catch (err) {
      console.warn(`  ⚠️  Failed to restore backup-${i}:`, err);
    }
  }

  return false;
}

// ============================================================================
// Transient state cleanup
// ============================================================================

/**
 * Directories that hold transient runtime state tightly coupled to the WAL.
 * When WAL replay fails, these are also likely inconsistent and must be cleared
 * together with the WAL to give PGlite the best chance of opening cleanly.
 */
const TRANSIENT_DIRS = [
  "pg_wal",
  "pg_xact",
  "pg_commit_ts",
  "pg_multixact",
  "pg_logical",
  "pg_subtrans",
  "pg_twophase",
  "pg_notify",
  "pg_replslot",
  "pg_stat",
  "pg_stat_tmp",
  "pg_snapshots",
  "pg_serial",
  "pg_dynshmem",
] as const;

function clearTransientState(dataDir: string): void {
  let total = 0;
  for (const dir of TRANSIENT_DIRS) {
    const fullPath = path.join(dataDir, dir);
    if (!existsSync(fullPath)) continue;
    const entries = readdirSync(fullPath);
    for (const entry of entries) {
      rmSync(path.join(fullPath, entry), { force: true, recursive: true });
    }
    total += entries.length;
  }
  if (total > 0) {
    console.warn(`  Cleared ${total} transient file(s) from ${dataDir}`);
  }
}

function removePidFile(dataDir: string): void {
  const pidFile = path.join(dataDir, "postmaster.pid");
  if (existsSync(pidFile)) {
    rmSync(pidFile, { force: true });
  }
}

// ============================================================================
// Health check
// ============================================================================

async function healthCheck(dataDir: string): Promise<PGlite> {
  const pglite = new PGlite(dataDir);
  await pglite.query("SELECT 1");
  return pglite;
}

async function tryClose(pglite: PGlite | null): Promise<void> {
  if (!pglite) return;
  try {
    await pglite.close();
  } catch {
    // Already broken or closed
  }
}

// ============================================================================
// Main repair entry point
// ============================================================================

/**
 * Detect and repair a corrupted PGlite database.
 *
 * Progressive strategy:
 * 1. Clear stale locks, try to open → if healthy, create rolling backup
 * 2. Clear WAL + transient state (preserves base data) and retry
 * 3. Restore from most recent rolling backup
 * 4. Nuke the entire data dir and let migrations rebuild
 */
export async function repairPGliteIfCorrupted(): Promise<void> {
  const dataDir = parsePGlitePath();
  if (!dataDir) return;
  if (!existsSync(dataDir)) return;

  // Clear stale locks first
  clearStalePGliteLock(dataDir);

  // Attempt 1: open as-is
  let pglite: PGlite | null = null;
  try {
    pglite = await healthCheck(dataDir);
    // DB is healthy — checkpoint and create a rolling backup
    try {
      await pglite.query("CHECKPOINT");
    } catch {
      // Best effort
    }
    await pglite.close();
    createRollingBackup(dataDir);
    return;
  } catch {
    await tryClose(pglite);
  }

  // Attempt 2: clear WAL + transient state + pid, retry
  console.warn("⚠️  PGlite database appears corrupted. Attempting repair...");
  console.warn(
    "   (Clearing WAL + transient state to recover — base table data preserved)",
  );
  clearTransientState(dataDir);
  removePidFile(dataDir);

  pglite = null;
  try {
    pglite = await healthCheck(dataDir);
    try {
      await pglite.query("CHECKPOINT");
    } catch {
      // Best effort
    }
    await pglite.close();
    console.log(
      "✅ PGlite repair successful — database recovered, data preserved.",
    );
    createRollingBackup(dataDir);
    return;
  } catch {
    await tryClose(pglite);
  }

  // Attempt 3: restore from rolling backup
  console.warn("⚠️  Transient state repair failed. Trying rolling backup...");
  const restored = restoreFromBackup(dataDir);
  if (restored) {
    pglite = null;
    try {
      pglite = await healthCheck(dataDir);
      await pglite.close();
      console.log(
        "✅ PGlite restored from backup — data recovered from last known-good state.",
      );
      return;
    } catch {
      await tryClose(pglite);
      console.warn("⚠️  Restored backup also failed to open.");
    }
  }

  // Attempt 4: full nuke — data is unrecoverable, rebuild from scratch
  console.warn(
    "⚠️  All recovery options exhausted — database files are too corrupted.",
  );
  console.warn(
    "   Removing and recreating database (migrations will rebuild schema)...",
  );
  rmSync(dataDir, { recursive: true, force: true });

  pglite = null;
  try {
    pglite = await healthCheck(dataDir);
    await pglite.close();
    console.log(
      "✅ PGlite database recreated from scratch. You may need to re-add API keys and org setup.",
    );
  } catch (finalError) {
    await tryClose(pglite);
    throw new Error(
      `PGlite auto-repair failed completely. Could not create a fresh database at ${dataDir}.\n` +
        `Original error: ${finalError}`,
    );
  }
}
