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
 * Every platform the channel serves, keyed by the updater's own `{os}-{arch}`
 * identifier (tauri-plugin-updater's `updater_os`/`updater_arch`) and mapped to
 * the updater asset's name on the immutable `native-v<version>` release.
 *
 * The key vocabulary is NOT the bundler's: the AppImage the tarball wraps is
 * `amd64`, the manifest key is `x86_64`. Never derive one from the other.
 *
 * Adding a key here makes that platform MANDATORY for every manifest — which
 * is the point. `buildLatestJson` refuses to emit a partial document because
 * the updater validates the whole file before reading `version`, so one
 * missing or malformed entry bricks updates for ALL platforms, not just the
 * absent one. A platform whose assets aren't ready yet must hold the whole
 * promotion back, not ship a manifest without it.
 */
export const PLATFORM_ASSETS = {
  "darwin-aarch64": (version) => `deco-${version}-aarch64.app.tar.gz`,
  "linux-x86_64": (version) => `deco-${version}-linux-x86_64.AppImage.tar.gz`,
};

/**
 * Assemble latest.json for the Tauri updater. Structured construction, never
 * shell/string interpolation — signatures are base64 today but correctness
 * stays by-construction.
 *
 * `url` points at the immutable native-v<version> release asset, so an old
 * manifest never dangles; each `signature` is the CONTENTS of that platform's
 * .sig file (a path or URL does not work, per the updater docs).
 *
 * @param {object} args
 * @param {string} args.version
 * @param {Record<string, string>} args.signatures .sig CONTENTS keyed by
 *   platform; must cover exactly PLATFORM_ASSETS
 * @param {string} args.repo owner/repo
 * @param {string} args.pubDate
 */
export function buildLatestJson({ version, signatures, repo, pubDate }) {
  if (!parseSemver(version)) {
    throw new Error(
      `refusing to build manifest for unparseable version ${JSON.stringify(version)}`,
    );
  }
  if (
    signatures === null ||
    typeof signatures !== "object" ||
    Array.isArray(signatures)
  ) {
    throw new Error("signatures must be an object keyed by platform");
  }

  const expected = Object.keys(PLATFORM_ASSETS);
  const unknown = Object.keys(signatures).filter(
    (key) => !(key in PLATFORM_ASSETS),
  );
  if (unknown.length > 0) {
    throw new Error(
      `unknown platform key(s) ${unknown.join(", ")}; expected ${expected.join(", ")}`,
    );
  }

  const platforms = {};
  const missing = [];
  for (const [key, assetName] of Object.entries(PLATFORM_ASSETS)) {
    const signature = signatures[key];
    if (typeof signature !== "string" || signature.trim() === "") {
      missing.push(key);
      continue;
    }
    platforms[key] = {
      url: `https://github.com/${repo}/releases/download/native-v${version}/${assetName(version)}`,
      signature: signature.trim(),
    };
  }
  if (missing.length > 0) {
    throw new Error(
      `missing updater signature contents for ${missing.join(", ")}`,
    );
  }

  return {
    version,
    pub_date: pubDate,
    notes: `https://github.com/${repo}/releases/tag/native-v${version}`,
    platforms,
  };
}

function platformKeysOf(manifest) {
  const platforms =
    manifest && typeof manifest === "object" ? manifest.platforms : null;
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
    return [];
  }
  return Object.keys(platforms);
}

/**
 * Coverage-regression guard, run against the CURRENTLY-PUBLISHED manifest
 * before uploading a new one.
 *
 * `shouldPromote` compares only `version`, so a repair dispatch from a ref
 * predating a platform key — or a revert — can legitimately decide to promote
 * a narrower manifest over a wider one. Nothing downstream would notice: the
 * dropped platform's clients simply poll a manifest without their key and see
 * "no update" forever, with no failed job and no dangling URL to grep for.
 *
 * Fail-open on an absent/unreadable current manifest, matching `shouldPromote`
 * — there is nothing to regress from. Fail CLOSED on an empty next manifest:
 * we just built it, so we know exactly what it should contain.
 *
 * @param {object} args
 * @param {object} args.nextManifest the manifest about to be uploaded
 * @param {object|null} args.currentManifest the published one, or null
 */
export function assertPlatformCoverage({ nextManifest, currentManifest }) {
  const next = platformKeysOf(nextManifest);
  if (next.length === 0) {
    throw new Error("refusing to publish a manifest with no platforms");
  }
  const current = platformKeysOf(currentManifest);
  const dropped = current.filter((key) => !next.includes(key));
  if (dropped.length > 0) {
    throw new Error(
      `refusing to publish a manifest dropping platform(s) ${dropped.join(", ")}: ` +
        `published channel serves ${current.join(", ")}, candidate serves ${next.join(", ")}`,
    );
  }
}

/**
 * `<platformKey>=<path>` pairs from repeated `--sig-file` flags → a
 * `{ [platformKey]: path }` map. Rejects anything malformed rather than
 * silently dropping a platform, since a dropped platform is exactly the
 * failure this whole module exists to prevent. Paths may contain `=`; the
 * key ends at the FIRST one.
 *
 * @param {string[]} pairs
 * @returns {Record<string, string>}
 */
export function parseSigFilePairs(pairs) {
  const out = {};
  for (const pair of pairs) {
    const at = typeof pair === "string" ? pair.indexOf("=") : -1;
    if (at < 1 || at === pair.length - 1) {
      throw new Error(
        `malformed --sig-file ${JSON.stringify(pair ?? null)}; expected <platform>=<path>`,
      );
    }
    const key = pair.slice(0, at);
    if (key in out) {
      throw new Error(`duplicate --sig-file for platform ${key}`);
    }
    out[key] = pair.slice(at + 1);
  }
  return out;
}

// Flags that may appear more than once collect into an array; everything else
// keeps last-writer-wins.
const REPEATABLE_FLAGS = new Set(["sig-file"]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") {
      args.force = true;
      continue;
    }
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const value = argv[++i];
    if (REPEATABLE_FLAGS.has(key)) {
      args[key] = [...(args[key] ?? []), value];
    } else {
      args[key] = value;
    }
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
    const signatures = {};
    for (const [platform, path] of Object.entries(
      parseSigFilePairs(args["sig-file"] ?? []),
    )) {
      signatures[platform] = readFileSync(path, "utf8");
    }
    const manifest = buildLatestJson({
      version: args.version,
      signatures,
      repo: args.repo,
      pubDate: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  if (cmd === "check-coverage") {
    // The candidate must parse — it was just built by this run. The published
    // one is read with the same fail-open convention as should-promote.
    const nextManifest = JSON.parse(readFileSync(args["next-file"], "utf8"));
    let currentManifest = null;
    try {
      currentManifest = JSON.parse(readFileSync(args["current-file"], "utf8"));
    } catch {
      // absent or unreadable published manifest → nothing to regress from
    }
    assertPlatformCoverage({ nextManifest, currentManifest });
    return;
  }

  process.stderr.write(
    "usage: native-update-channel.mjs should-promote --candidate <ver> --current-file <path> [--force]\n" +
      "       native-update-channel.mjs build --version <ver> --repo <owner/repo> --sig-file <platform>=<path> [--sig-file ...]\n" +
      "       native-update-channel.mjs check-coverage --next-file <path> --current-file <path>\n" +
      `       platforms: ${Object.keys(PLATFORM_ASSETS).join(", ")}\n`,
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
