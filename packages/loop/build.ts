// Bundles the CLI for plain Node (bun is a build tool here, not a runtime
// requirement): --target node inlines @decocms/shared/std, and the shebang
// is rewritten from the dev-time bun one to node.
import { readFileSync, writeFileSync } from "node:fs";
import { $ } from "bun";

await $`bun build src/cli.ts --target node --outfile dist/cli.js`;
const out = readFileSync("dist/cli.js", "utf8");
writeFileSync("dist/cli.js", out.replace(/^#!.*/, "#!/usr/bin/env node"));
console.log("dist/cli.js: node-target bundle, node shebang");
