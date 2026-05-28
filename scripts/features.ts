#!/usr/bin/env bun
/**
 * Feature catalog CLI.
 *
 *   bun run features:list                  → list every catalogued feature
 *   bun run features:test                  → run every feature's happy path
 *   bun run features:test <name>           → run one feature
 *   PW=1 bun run features:test <name>      → include the (future) browser leg
 *
 * The CLI is intentionally thin: each feature owns its `happy-path.test.ts`
 * and the CLI just locates and forwards to `bun test`. The shape exists so
 * agents have a stable invocation for "run the contract for area X" instead
 * of grepping the tree every time.
 *
 * See features/README.md for the catalog invariants and the AGENTS.md
 * "Working on a feature" section for the workflow this CLI enables.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const FEATURES_DIR = join(REPO_ROOT, "features");

interface Feature {
  name: string;
  dir: string;
  /** First-line value statement from feature.md (the blockquote under H1). */
  tagline: string;
  testFile: string;
  hasTest: boolean;
}

function listFeatures(): Feature[] {
  if (!existsSync(FEATURES_DIR)) return [];
  const entries = readdirSync(FEATURES_DIR);
  const features: Feature[] = [];
  for (const entry of entries) {
    const dir = join(FEATURES_DIR, entry);
    if (!statSync(dir).isDirectory()) continue;
    if (entry.startsWith(".") || entry.startsWith("_")) continue;
    const featureMd = join(dir, "feature.md");
    if (!existsSync(featureMd)) continue;
    const testFile = join(dir, "happy-path.test.ts");
    features.push({
      name: entry,
      dir,
      tagline: extractTagline(featureMd),
      testFile,
      hasTest: existsSync(testFile),
    });
  }
  features.sort((a, b) => a.name.localeCompare(b.name));
  return features;
}

function extractTagline(featureMd: string): string {
  const src = readFileSync(featureMd, "utf8");
  // First blockquote (`> ...`) after the H1 is the canonical one-liner.
  for (const line of src.split("\n")) {
    const m = line.match(/^\s*>\s+(.+?)\s*$/);
    if (m) return m[1]!;
  }
  return "(no tagline)";
}

function cmdList(): void {
  const features = listFeatures();
  if (features.length === 0) {
    console.error("No features catalogued yet. See features/README.md.");
    process.exit(1);
  }
  const maxName = Math.max(...features.map((f) => f.name.length));
  for (const f of features) {
    const dot = f.hasTest ? "●" : "○";
    console.log(`${dot} ${f.name.padEnd(maxName)}  ${f.tagline}`);
  }
  console.log();
  console.log(
    `Run a feature: bun run features:test <name>   (● = test present, ○ = missing)`,
  );
}

function cmdTest(name: string | undefined): never {
  const features = listFeatures();
  if (features.length === 0) {
    console.error("No features catalogued. See features/README.md.");
    process.exit(1);
  }

  let targets: Feature[];
  if (name) {
    const match = features.find((f) => f.name === name);
    if (!match) {
      console.error(`Unknown feature: "${name}"`);
      console.error(`Catalogued: ${features.map((f) => f.name).join(", ")}`);
      process.exit(1);
    }
    targets = [match];
  } else {
    targets = features;
  }

  const missing = targets.filter((f) => !f.hasTest);
  if (missing.length > 0) {
    console.error(
      `Missing happy-path.test.ts: ${missing.map((m) => m.name).join(", ")}`,
    );
    console.error(
      "Every catalogued feature needs a test. Either add the test or remove the feature.",
    );
    process.exit(1);
  }

  const testPaths = targets.map((f) => f.testFile);
  console.log(
    `Running ${targets.length} feature${targets.length === 1 ? "" : "s"}:`,
  );
  for (const f of targets) console.log(`  • ${f.name}`);
  console.log();

  // Phase A–E: in-process Bun tests against the service layer.
  const dataResult = spawnSync("bun", ["test", ...testPaths], {
    stdio: "inherit",
    cwd: REPO_ROOT,
  });
  if (dataResult.status !== 0) {
    process.exit(dataResult.status ?? 1);
  }

  // Phase F (browser): only when PW=1, only for features that ship a
  // `*.browser.spec.ts` next to the auth fixtures. Playwright owns its
  // own config (apps/mesh/playwright.config.ts) so we shell out
  // matching specs by name. The dev server auto-starts via Playwright's
  // webServer config.
  if (process.env.PW === "1") {
    const browserSpecs = targets.map((f) =>
      join("apps/mesh/e2e/tests/features", `${f.name}.browser.spec.ts`),
    );
    const present = browserSpecs.filter((p) => existsSync(join(REPO_ROOT, p)));
    if (present.length === 0) {
      console.log(
        "(PW=1) no browser specs found next to apps/mesh/e2e/tests/features/",
      );
      process.exit(0);
    }
    console.log(`\n(PW=1) running ${present.length} browser spec(s)\n`);
    const browserResult = spawnSync(
      "bun",
      ["--bun", "exec", "playwright", "test", ...present],
      { stdio: "inherit", cwd: join(REPO_ROOT, "apps/mesh") },
    );
    process.exit(browserResult.status ?? 1);
  }

  process.exit(0);
}

function cmdNew(name: string | undefined): never {
  if (!name) {
    console.error("Usage: bun run features:new <name>");
    process.exit(1);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    console.error(
      `Invalid feature name "${name}". Use kebab-case: lowercase, digits, hyphens, must start with a letter.`,
    );
    process.exit(1);
  }
  const dir = join(FEATURES_DIR, name);
  if (existsSync(dir)) {
    console.error(`Feature "${name}" already exists at ${dir}`);
    process.exit(1);
  }
  // Scaffold is deliberately left as a follow-up; for now, point to the
  // page-editor template so the contributor copies + adapts.
  console.error(
    `Scaffold not implemented yet. Copy features/page-editor/{feature.md,happy-path.test.ts} as a starting point and adapt for "${name}".`,
  );
  process.exit(1);
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case "list":
    cmdList();
    break;
  case "test":
    cmdTest(rest[0]);
    break;
  case "new":
    cmdNew(rest[0]);
    break;
  default:
    console.error("Usage: bun run features:<list|test|new> [name]");
    process.exit(1);
}
