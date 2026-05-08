import fs from "node:fs";
import type { PackageManager } from "../types";

/** Returns [] when PM is null or no manifest is found. */
export function discoverScripts(
  appRoot: string,
  pm: PackageManager | null,
): string[] {
  if (!pm) return [];
  let scripts: Record<string, string> = {};
  try {
    if (pm === "deno") {
      for (const f of ["deno.json", "deno.jsonc"]) {
        try {
          const raw = fs.readFileSync(`${appRoot}/${f}`, "utf-8");
          const parsed = JSON.parse(raw) as { tasks?: Record<string, string> };
          scripts = parsed.tasks ?? {};
          break;
        } catch {
          /* try next */
        }
      }
    } else {
      try {
        const raw = fs.readFileSync(`${appRoot}/package.json`, "utf-8");
        const parsed = JSON.parse(raw) as {
          scripts?: Record<string, string>;
        };
        scripts = parsed.scripts ?? {};
      } catch {
        /* no package.json */
      }
    }
  } catch {
    return [];
  }
  return Object.keys(scripts);
}
