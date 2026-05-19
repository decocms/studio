import fs from "node:fs";
import { join } from "node:path";

const DENO_MANIFESTS = ["deno.json", "deno.jsonc"] as const;

/**
 * Flags that should be stripped from Deno task definitions in the sandbox.
 * `--unstable-hmr` relies on filesystem watchers that don't work inside
 * containers and causes Deno to crash or hang on startup.
 */
const BANNED_FLAGS = ["--unstable-hmr"];

const BANNED_RE = new RegExp(
  BANNED_FLAGS.map((f) => `\\s*${f.replace(/-/g, "\\-")}(?:=[^\\s]*)?`).join(
    "|",
  ),
  "g",
);

/**
 * Remove banned flags (e.g. `--unstable-hmr`) from every task value in
 * `deno.json` / `deno.jsonc`. Writes the file back only when something
 * actually changed. Returns `true` if the file was modified.
 */
export function sanitizeDenoTasks(appRoot: string): boolean {
  for (const filename of DENO_MANIFESTS) {
    const filepath = join(appRoot, filename);
    let raw: string;
    try {
      raw = fs.readFileSync(filepath, "utf-8");
    } catch {
      continue;
    }

    let parsed: { tasks?: Record<string, string> };
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const tasks = parsed.tasks;
    if (!tasks || typeof tasks !== "object") continue;

    let changed = false;
    for (const [name, cmd] of Object.entries(tasks)) {
      if (typeof cmd !== "string") continue;
      const cleaned = cmd
        .replace(BANNED_RE, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (cleaned !== cmd) {
        tasks[name] = cleaned;
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(filepath, JSON.stringify(parsed, null, 2) + "\n");
      return true;
    }
  }
  return false;
}
