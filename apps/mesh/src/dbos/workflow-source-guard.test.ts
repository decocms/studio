import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareToSnapshot,
  computeWorkflowSourceHashes,
} from "./workflow-source-guard";

describe("compareToSnapshot", () => {
  const snap = { "a.ts": "hash-a", "b.ts": "hash-b" };

  it("ok when identical", () => {
    const r = compareToSnapshot({ ...snap }, snap);
    expect(r.ok).toBe(true);
  });

  it("flags a changed file", () => {
    const r = compareToSnapshot({ "a.ts": "X", "b.ts": "hash-b" }, snap);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("changed: a.ts");
    expect(r.message).toContain("DBOS_WORKFLOW_VERSION");
  });

  it("flags a new workflow file", () => {
    const r = compareToSnapshot({ ...snap, "c.ts": "h" }, snap);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("new workflow file: c.ts");
  });

  it("flags a removed workflow file", () => {
    const r = compareToSnapshot({ "a.ts": "hash-a" }, snap);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("removed workflow file: b.ts");
  });
});

describe("workflow source guard (real files)", () => {
  it("registered-workflow sources match the committed snapshot", () => {
    const srcRoot = join(import.meta.dir, "..");
    const snapshot = JSON.parse(
      readFileSync(
        join(import.meta.dir, "workflow-source-guard.snapshot.json"),
        "utf8",
      ),
    ) as Record<string, string>;
    const current = computeWorkflowSourceHashes(srcRoot);
    const { ok, message } = compareToSnapshot(current, snapshot);
    if (!ok) throw new Error(message);
    expect(ok).toBe(true);
  });
});
