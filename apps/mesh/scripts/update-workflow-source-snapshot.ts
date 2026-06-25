import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeWorkflowSourceHashes } from "../src/dbos/workflow-source-guard";

const srcRoot = join(import.meta.dir, "..", "src");
const snapshotPath = join(
  srcRoot,
  "dbos",
  "workflow-source-guard.snapshot.json",
);

const hashes = computeWorkflowSourceHashes(srcRoot);
writeFileSync(snapshotPath, `${JSON.stringify(hashes, null, 2)}\n`);
console.log(
  `Wrote ${Object.keys(hashes).length} workflow-source hashes to ${snapshotPath}`,
);
