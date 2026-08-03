#!/usr/bin/env node
/**
 * `bun run --cwd apps/native check:junit-allowlist -- <junit.xml> <allowlist.json>`
 *
 * Exact-fail-set gate for a `bun test --reporter=junit` run. Two CI jobs
 * (`daemon-e2e-vs-rust`, `stub-seam-nightly` — see `.github/workflows/native.yml`)
 * run a curated slice of `packages/sandbox/daemon-e2e/daemon.*.e2e.test.ts` against a
 * Rust/stub binary that is INTENTIONALLY not byte-parity with the TS daemon (see
 * the native parity contract and
 * the daemon parity contract for why each documented failure is
 * pinned-intentional, not a bug). Both docs record the CURRENT exact set of
 * failing test names. This script re-derives the actual failing set from the
 * junit XML a run just produced and diffs it against that pinned set:
 *
 *   - a test in `actual` but NOT in `allowlist` → a NEW failure (regression) → fail.
 *   - a test in `allowlist` but NOT in `actual`  → a VANISHED documented failure
 *     (the divergence this test pinned no longer reproduces — good news, but it
 *     means the doc + allowlist are stale and must be updated deliberately, not
 *     silently absorbed as a free pass) → fail.
 *
 * A plain pass/fail COUNT check (`133 pass / 7 fail`) would not catch a
 * same-count swap (one documented failure "fixed" by accident while an unrelated
 * test newly breaks) — this is why the brief asks for a set match, not a count.
 *
 * Zero dependencies (stdlib `node:fs` + a small regex-based junit-XML reader) so
 * it needs no `bun install` step beyond what the calling job already ran.
 */
import { readFileSync } from "node:fs";

function decodeXmlEntities(s) {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * Extracts the set of failing test full-names (`"<classname> > <name>"`) from a
 * `bun test --reporter=junit` XML file. Regex-based rather than a full XML
 * parser: junit test-case names/classnames are attribute values (single line,
 * XML-entity-escaped, no nested elements) — a real parser is not needed for
 * this shape, and it keeps this script dependency-free.
 */
function extractFailingTests(xmlPath) {
  const xml = readFileSync(xmlPath, "utf8");
  const failing = [];
  let total = 0;
  const testcaseRe = /<testcase\s+([^>]*?)(\/>|>[\s\S]*?<\/testcase>)/g;
  let m;
  while ((m = testcaseRe.exec(xml)) !== null) {
    total++;
    const [, attrs, body] = m;
    const nameMatch = /\bname="([^"]*)"/.exec(attrs);
    const classnameMatch = /\bclassname="([^"]*)"/.exec(attrs);
    if (!nameMatch || !classnameMatch) {
      throw new Error(
        `check-junit-allowlist: <testcase> missing name/classname attr in ${xmlPath}: ${attrs}`,
      );
    }
    const name = decodeXmlEntities(nameMatch[1]);
    const classname = decodeXmlEntities(classnameMatch[1]);
    if (body.includes("<failure") || body.includes("<error")) {
      failing.push(`${classname} > ${name}`);
    }
  }
  return { total, failing };
}

function main() {
  const [, , xmlPath, allowlistPath] = process.argv;
  if (!xmlPath || !allowlistPath) {
    console.error(
      "usage: check-junit-allowlist.mjs <junit.xml> <allowlist.json>",
    );
    process.exit(2);
  }

  const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
  if (
    !Array.isArray(allowlist) ||
    !allowlist.every((x) => typeof x === "string")
  ) {
    console.error(
      `check-junit-allowlist: ${allowlistPath} must be a JSON array of strings`,
    );
    process.exit(2);
  }

  const { total, failing } = extractFailingTests(xmlPath);
  const actualSet = new Set(failing);
  const allowSet = new Set(allowlist);

  const newFailures = [...actualSet].filter((t) => !allowSet.has(t)).sort();
  const vanished = [...allowSet].filter((t) => !actualSet.has(t)).sort();

  console.log(
    `check-junit-allowlist: ${xmlPath} — ${total} tests, ${failing.length} failing, ` +
      `${allowlist.length} pinned in ${allowlistPath}`,
  );

  if (newFailures.length === 0 && vanished.length === 0) {
    console.log(
      `OK: failing-test set matches the pinned allowlist exactly (${failing.length} tests).`,
    );
    return;
  }

  if (newFailures.length > 0) {
    console.error(
      `\nNEW failure(s) — not in ${allowlistPath} (${newFailures.length}):`,
    );
    for (const t of newFailures) console.error(`  + ${t}`);
  }
  if (vanished.length > 0) {
    console.error(
      `\nVANISHED documented failure(s) — pinned in ${allowlistPath} but did not fail this run (${vanished.length}):`,
    );
    for (const t of vanished) console.error(`  - ${t}`);
    console.error(
      "\nA vanished documented failure usually means the underlying divergence was\n" +
        "fixed (good) — update the allowlist AND the prose doc it was copied from\n" +
        "(the native parity contract or\n" +
        "the daemon parity contract) deliberately, in the same PR\n" +
        "that fixed it, rather than leaving a stale exclusion on the books.",
    );
  }
  console.error(
    "\nFAIL: failing-test set does not exactly match the pinned allowlist.",
  );
  process.exit(1);
}

main();
