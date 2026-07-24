import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import migrations from "./index";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Guardrail for a real incident: a migration file was added to this directory
 * but never registered in index.ts, so Kysely never ran it (org_sites was
 * missing in prod). Every `NNN-name.ts` migration file MUST appear in the
 * exported `migrations` record, and vice-versa.
 */
describe("migrations index", () => {
  const fileNames = readdirSync(here)
    .filter((f) => /^\d{3,}-.*\.ts$/.test(f))
    .filter((f) => !f.endsWith(".test.ts"))
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();
  const registered = Object.keys(migrations).sort();

  it("registers every migration file (none forgotten)", () => {
    const missing = fileNames.filter((f) => !registered.includes(f));
    expect(missing).toEqual([]);
  });

  it("has no registration pointing at a missing/renamed file", () => {
    const orphaned = registered.filter((r) => !fileNames.includes(r));
    expect(orphaned).toEqual([]);
  });
});
