#!/usr/bin/env bun
/**
 * Pre-run cleanup for PGlite: nukes the entire data directory so migrations
 * start fresh.  PGlite (WASM-based) is extremely sensitive to stale WAL,
 * lock files, and partial writes — a corrupted dir is unrecoverable without
 * a full reset.  Since this is local dev, all data is recreatable.
 *
 * This is the "on start" counterpart of the SIGINT/SIGTERM checkpoint handler.
 */

import { existsSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const dataDir =
  process.env.DATABASE_URL?.replace(/^file:\/\//, "") ??
  join(homedir(), "deco", "db.pglite");

if (!existsSync(dataDir)) {
  process.exit(0);
}

rmSync(dataDir, { recursive: true, force: true });
console.log("🧹 Removed PGlite data directory (will recreate on startup)");
