#!/usr/bin/env node
// Updater-channel logic for release-native.yaml, extracted so the decision
// rules run under `bun test` instead of first executing in a production
// release on a BSD-date macOS runner (the boot-smoke-paths.ts precedent:
// risky script logic lives in a tested module; the workflow keeps only `gh`
// invocations). Zero dependencies, plain Node — same conventions as
// check-junit-allowlist.mjs.
//
// The "channel" is the rolling `native-updates` prerelease whose single
// `latest.json` asset the Tauri updater polls. Promotion is throttled to
// ~daily (releases track the ~12x/day cloud cadence at ~80 MB/artifact) and
// every skip/promote decision is printed by the workflow as a ::notice:: so
// silent-skip streaks are greppable.

/** Strict `X.Y.Z` (optional leading `v`) → `[major, minor, patch]`, else null.
 * Release versions come from release-changes.ts and are always a plain
 * triple; anything else (prerelease tags, garbage from a clobbered manifest)
 * deliberately fails to parse and falls through to the fail-open branches. */
export function parseSemver(version) {
  if (typeof version !== "string") return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 | 0 | 1, or null when either side is unparseable. */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export const THROTTLE_MS = 20 * 60 * 60 * 1000;

/**
 * Decide whether to clobber the channel manifest with `candidateVersion`.
 *
 * Fail-open-to-promote by design: every ambiguous state (missing manifest,
 * unparseable JSON, bad or FUTURE pub_date) promotes. A clobbered far-future
 * pub_date must not freeze the channel forever, and clock skew heals instead
 * of wedging. The only skips are "channel already has this or newer" and the
 * ~daily throttle — and a `workflow_dispatch` force bypasses the throttle
 * (urgent fixes, healing a half-failed promotion).
 *
 * @param {object} args
 * @param {object|null} args.currentManifest parsed latest.json, or null when
 *   absent/unreadable (first-ever promotion, corrupt asset)
 * @param {string} args.candidateVersion this release's version
 * @param {number} args.nowMs epoch millis
 * @param {boolean} args.force workflow_dispatch force-promote input
 * @returns {{ promote: boolean, reason: string }}
 */
export function shouldPromote({
  currentManifest,
  candidateVersion,
  nowMs,
  force,
}) {
  if (!currentManifest || typeof currentManifest !== "object") {
    return { promote: true, reason: "no existing channel manifest" };
  }

  const cmp = compareSemver(currentManifest.version, candidateVersion);
  if (cmp === 1) {
    // Never regress the channel — a repair dispatch running on an old ref
    // must not replace a newer manifest. Not even --force overrides this.
    return {
      promote: false,
      reason: `channel already at newer ${currentManifest.version}`,
    };
  }
  if (cmp === 0 && !force) {
    // Same version: idempotent skip. A forced dispatch still re-promotes so
    // a corrupt-but-parseable manifest of the current version can be healed.
    return {
      promote: false,
      reason: `channel already at ${currentManifest.version}`,
    };
  }

  if (force) {
    return { promote: true, reason: "forced by workflow_dispatch" };
  }

  const pubDateMs = Date.parse(currentManifest.pub_date ?? "");
  if (Number.isNaN(pubDateMs) || pubDateMs > nowMs) {
    return {
      promote: true,
      reason: "manifest pub_date missing, invalid, or in the future",
    };
  }
  const ageMs = nowMs - pubDateMs;
  if (ageMs < THROTTLE_MS) {
    const ageH = (ageMs / 3_600_000).toFixed(1);
    return {
      promote: false,
      reason: `throttled: manifest is ${ageH}h old (< 20h)`,
    };
  }
  return { promote: true, reason: "manifest older than 20h" };
}

/**
 * Assemble latest.json for the Tauri updater. Structured construction, never
 * shell/string interpolation — the signature is base64 today but correctness
 * stays by-construction. The updater validates the WHOLE file before reading
 * `version`, so when platform keys are added later one malformed entry
 * bricks updates for all platforms — keep every entry complete.
 *
 * `url` points at the immutable native-v<version> release asset, so an old
 * manifest never dangles; `signature` is the CONTENTS of the .sig file (a
 * path or URL does not work, per the updater docs).
 */
export function buildLatestJson({ version, signature, repo, pubDate }) {
  if (!parseSemver(version)) {
    throw new Error(
      `refusing to build manifest for unparseable version ${JSON.stringify(version)}`,
    );
  }
  if (typeof signature !== "string" || signature.trim() === "") {
    throw new Error("missing updater signature contents");
  }
  return {
    version,
    pub_date: pubDate,
    notes: `https://github.com/${repo}/releases/tag/native-v${version}`,
    platforms: {
      "darwin-aarch64": {
        url: `https://github.com/${repo}/releases/download/native-v${version}/deco-${version}-aarch64.app.tar.gz`,
        signature: signature.trim(),
      },
    },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") args.force = true;
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
  }
  return args;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const { readFileSync } = await import("node:fs");

  if (cmd === "should-promote") {
    let currentManifest = null;
    try {
      currentManifest = JSON.parse(readFileSync(args["current-file"], "utf8"));
    } catch {
      // absent or unreadable manifest → null → fail-open promote
    }
    const decision = shouldPromote({
      currentManifest,
      candidateVersion: args.candidate,
      nowMs: Date.now(),
      force: args.force === true,
    });
    process.stdout.write(JSON.stringify(decision));
    return;
  }

  if (cmd === "build") {
    const manifest = buildLatestJson({
      version: args.version,
      signature: readFileSync(args["sig-file"], "utf8"),
      repo: args.repo,
      pubDate: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  process.stderr.write(
    "usage: native-update-channel.mjs should-promote --candidate <ver> --current-file <path> [--force]\n" +
      "       native-update-channel.mjs build --version <ver> --sig-file <path> --repo <owner/repo>\n",
  );
  process.exit(2);
}

// Only run the CLI when invoked directly, so tests can import the pure fns.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
