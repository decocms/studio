/**
 * Builds the `decocms` CLI the sandbox image installs, from this revision:
 *
 *   <out>/bin/decocms.js   apps/api/src/cli.ts bundled for Bun, no node_modules
 *   <out>/package.json     its version, read by `decocms --version`
 *   <out>/plugin/          apps/api/plugin, the decocms-studio skill as a plugin
 *
 * Usage: bun scripts/build-studio-cli.ts <out-dir>
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { z } from "zod";

const API_DIR = resolve(import.meta.dir, "../../../apps/api");
const ENTRY = join(API_DIR, "src/cli.ts");

/** Commands that run against Studio's own database and storage; stubbed so the server stays out of the bundle. */
const SERVER_ONLY_COMMANDS = /\/cli\/commands\/backfill-assets$/;

const stubServerOnlyCommands: BunPlugin = {
  name: "stub-server-only-commands",
  setup(build) {
    build.onResolve({ filter: SERVER_ONLY_COMMANDS }, (args) => ({
      path: args.path,
      namespace: "server-only",
    }));
    build.onLoad({ filter: /.*/, namespace: "server-only" }, () => ({
      loader: "js",
      contents: `export async function backfillThreadAssetsCommand() {
  console.error("backfill-assets runs from the Studio server package, not this CLI build.");
  return 1;
}`,
    }));
  },
};

/** Studio modules the CLI may bundle: its entry and `src/cli/`. Anything else under apps/api is server code. */
function isServerModule(path: string): boolean {
  const rel = relative(API_DIR, path);
  if (rel.startsWith("..") || rel.includes("node_modules")) return false;
  return rel !== "src/cli.ts" && !rel.startsWith("src/cli/");
}

export async function buildStudioCli(outDir: string): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [ENTRY],
    target: "bun",
    metafile: true,
    plugins: [stubServerOnlyCommands],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "decocms CLI bundle failed");
  }
  const server = Object.keys(result.metafile?.inputs ?? {})
    .map((input) => resolve(input))
    .filter(isServerModule);
  if (server.length > 0) {
    throw new Error(
      `decocms CLI bundle pulls in server modules: ${server.join(", ")}. ` +
        "Add the command that imports them to SERVER_ONLY_COMMANDS.",
    );
  }
  const [bundle] = result.outputs;
  if (!bundle) throw new Error("decocms CLI bundle produced no output");

  await mkdir(join(outDir, "bin"), { recursive: true });
  await Bun.write(join(outDir, "bin/decocms.js"), bundle);
  const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(join(API_DIR, "package.json"), "utf8")));
  await writeFile(
    join(outDir, "package.json"),
    `${JSON.stringify({ name: "decocms", version, private: true }, null, 2)}\n`,
  );
  await cp(join(API_DIR, "plugin"), join(outDir, "plugin"), {
    recursive: true,
  });
}

if (import.meta.main) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("Usage: bun scripts/build-studio-cli.ts <out-dir>");
    process.exit(1);
  }
  await buildStudioCli(resolve(outDir));
}
