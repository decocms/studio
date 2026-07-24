import { Glob } from "bun";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Marker that identifies a file as registering a durable DBOS workflow. The
 * trailing "(" excludes prose mentions (e.g. the comment in queue-names.ts).
 * Split across a concatenation so this file does not match its own marker.
 */
const WORKFLOW_MARKER = "DBOS.registerWorkflow" + "(";

/** Non-test `.ts` files under rootDir that register a workflow, sorted. */
function discoverWorkflowFiles(rootDir: string): string[] {
  const glob = new Glob("**/*.ts");
  const out: string[] = [];
  for (const rel of glob.scanSync({ cwd: rootDir })) {
    if (rel.endsWith(".test.ts")) continue;
    if (readFileSync(join(rootDir, rel), "utf8").includes(WORKFLOW_MARKER)) {
      out.push(rel);
    }
  }
  return out.sort();
}

/** relPath -> sha256 of file contents, for every workflow file under rootDir. */
export function computeWorkflowSourceHashes(
  rootDir: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rel of discoverWorkflowFiles(rootDir)) {
    const content = readFileSync(join(rootDir, rel), "utf8");
    result[rel] = createHash("sha256").update(content).digest("hex");
  }
  return result;
}

/**
 * Conservative, file-level drift check. Over-triggers on unrelated edits inside
 * a workflow file (safe — it only forces a deliberate decision); never silently
 * misses a workflow source change for the standard `DBOS.registerWorkflow` call
 * form. A future aliased or destructured registration (e.g.
 * `const { registerWorkflow } = DBOS`) would evade the marker and go undetected.
 */
export function compareToSnapshot(
  current: Record<string, string>,
  snapshot: Record<string, string>,
): { ok: boolean; message: string } {
  const added = Object.keys(current)
    .filter((k) => !(k in snapshot))
    .sort();
  const removed = Object.keys(snapshot)
    .filter((k) => !(k in current))
    .sort();
  const changed = Object.keys(current)
    .filter((k) => k in snapshot && current[k] !== snapshot[k])
    .sort();

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return { ok: true, message: "" };
  }

  const lines = [
    "Registered-workflow source drift detected:",
    ...added.map((f) => `  + new workflow file: ${f}`),
    ...removed.map((f) => `  - removed workflow file: ${f}`),
    ...changed.map((f) => `  ~ changed: ${f}`),
    "",
    "If the change is recovery-compatible (logic inside a step, non-workflow",
    "code, comments), re-baseline the snapshot:",
    "  bun apps/api/scripts/update-workflow-source-snapshot.ts",
    "If it changes a workflow's STEP SEQUENCE, bump DBOS_WORKFLOW_VERSION in",
    "apps/api/src/dbos/workflow-version.ts FIRST, then re-baseline.",
  ];
  return { ok: false, message: lines.join("\n") };
}
