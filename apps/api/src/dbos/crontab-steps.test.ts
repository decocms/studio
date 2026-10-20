import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * DBOS's cron parser expands `a-b/s` to the values in a..b divisible by `s`,
 * not to a, a+s, …: `4-59/10` runs at :10, :20…, on top of every other
 * 10-minute sweep. An offset tick has to be written as a list.
 */
test("no crontab offsets a step with a range DBOS would misread", () => {
  const root = join(import.meta.dir, "..");
  const offenders: string[] = [];
  for (const rel of new Glob("**/*.ts").scanSync({ cwd: root })) {
    if (rel.endsWith(".test.ts")) continue;
    const source = readFileSync(join(root, rel), "utf8");
    for (const [, start, step] of source.matchAll(
      /"(\d+)-\d+\/(\d+)(?: [^"]*)?"/g,
    )) {
      if (Number(start) % Number(step) !== 0) offenders.push(rel);
    }
  }
  expect(offenders).toEqual([]);
});
