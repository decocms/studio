#!/usr/bin/env bun

/**
 * Asserts the browser build of `apps/web` contains no Tauri desktop code.
 *
 * `apps/web` builds two ways from one source tree: `build:web`
 * (`VITE_TAURI_APP=0`, entry `index.web.tsx`) and `build:native`
 * (`VITE_TAURI_APP=1`, entry `index.native.tsx`). Only the native entry may
 * reach the desktop bridge — everyone visiting Studio in a browser would
 * otherwise download an IPC client for a shell that isn't there.
 *
 * Nothing structural enforces that today. `@tauri-apps/api` and
 * `@tauri-apps/plugin-opener` are ordinary `dependencies` of `apps/web`, and
 * `lib/desktop/tauri-bridge.ts` imports them at module top level — a static
 * import, so a runtime `"__TAURI_INTERNALS__" in window` guard does not make
 * it shakeable. The browser bundle is clean only because no module reachable
 * from `index.web.tsx` currently imports the bridge. One `import` added to a
 * shared component pulls the whole tree in, silently.
 *
 * This checks the property that actually matters — what shipped — rather than
 * the import graph, because reachability is transitive and a lint rule reading
 * one file at a time cannot see it.
 *
 * Run against a completed `bun run --cwd=apps/web build:web`.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Defaults to the browser build. Takes a path so the guard can be pointed at
 * `apps/web/dist/native`, which SHOULD trip every marker — that run is how you
 * confirm the markers still survive minification and the check can still fail.
 */
const distDir =
  process.argv[2] ?? join(import.meta.dir, "..", "apps", "web", "dist");

/**
 * Literals that survive minification, so their absence is proof rather than
 * a hint: rollup does not mangle property names or rewrite string contents.
 *
 * `__TAURI_INTERNALS__` is the global `@tauri-apps/api/core` dispatches every
 * command through, and `plugin:opener|` prefixes the opener plugin's command
 * names. Either one appearing means the desktop bridge was bundled.
 */
const DESKTOP_MARKERS = [
  "__TAURI_INTERNALS__",
  "plugin:opener|",
  "@tauri-apps/",
] as const;

/** Text assets worth scanning; images and fonts cannot carry an import. */
const SCANNED_EXTENSIONS = [".js", ".mjs", ".cjs", ".css", ".html", ".map"];

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(path);
    }
  }
  return files;
}

const files = await collectFiles(distDir).catch(() => {
  console.error(
    `No build to check at ${distDir}.\n` +
      "Run `bun run --cwd=apps/web build:web` first.",
  );
  process.exit(1);
});

if (files.length === 0) {
  console.error(`${distDir} holds no scannable assets — is the build empty?`);
  process.exit(1);
}

const offenders: string[] = [];
for (const file of files) {
  const contents = await readFile(file, "utf8");
  const found = DESKTOP_MARKERS.filter((marker) => contents.includes(marker));
  if (found.length > 0) {
    offenders.push(`${file.slice(distDir.length + 1)} — ${found.join(", ")}`);
  }
}

if (offenders.length > 0) {
  console.error(
    "Tauri desktop code reached the browser bundle:\n" +
      offenders.map((line) => `  ${line}`).join("\n") +
      "\n\nSomething reachable from apps/web/src/index.web.tsx imports " +
      "@/lib/desktop/*, which imports @tauri-apps/* at module top level.\n" +
      "Import the bridge behind a dynamic import(), or move the code to the " +
      "native entry.",
  );
  process.exit(1);
}

console.log(`Browser bundle is desktop-free (${files.length} assets scanned).`);
