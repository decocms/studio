/**
 * Every board run starts as an automation fire: a person's Run, a delegation,
 * a retry, a review, a card entering a column. They all reach the run through
 * the fire workflow's card step (`card-run.ts`), so a run is always "an
 * automation fired, with a target". This fails when code anywhere else calls
 * a run dispatcher directly, which is the path this replaced.
 */

import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");

/** Who may call each dispatcher, by path under `apps/api/src`. */
const ALLOWED: Record<string, string[]> = {
  enqueueSuperAgentForTask: [
    "automations/card-run.ts",
    // Until the Jira trigger moves onto the fire workflow.
    "jira/trigger.ts",
  ],
  enqueueReviewerForTask: ["automations/card-run.ts"],
  // The two run builders above, which assemble the board run's request.
  enqueueAgentRunForTask: [
    "tools/task-board/enqueue-super-agent.ts",
    "tools/task-board/reviewer-run.ts",
  ],
};

function callers(name: string): string[] {
  const call = new RegExp(`(?<!function )\\b${name}\\(`);
  const found: string[] = [];
  for (const rel of new Glob("**/*.ts").scanSync({ cwd: SRC })) {
    if (rel.endsWith(".test.ts")) continue;
    const lines = readFileSync(join(SRC, rel), "utf8").split("\n");
    // Prose that names a dispatcher is not a call.
    if (lines.some((l) => call.test(l) && !/^\s*(\*|\/\/)/.test(l))) {
      found.push(rel);
    }
  }
  return found.sort();
}

describe("board runs start only from the fire workflow", () => {
  for (const [name, allowed] of Object.entries(ALLOWED)) {
    it(`${name} is called only from ${allowed.join(", ")}`, () => {
      expect(callers(name)).toEqual([...allowed].sort());
    });
  }
});
