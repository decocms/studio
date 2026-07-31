import { describe, expect, test } from "bun:test";
import {
  buildLatestJson,
  compareSemver,
  parseSemver,
  shouldPromote,
  THROTTLE_MS,
} from "./native-update-channel.mjs";

const NOW = Date.parse("2026-07-30T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const manifest = (version: string, pubDate?: string) => ({
  version,
  ...(pubDate !== undefined ? { pub_date: pubDate } : {}),
});

describe("parseSemver / compareSemver", () => {
  test("parses plain and v-prefixed triples", () => {
    expect(parseSemver("4.150.13")).toEqual([4, 150, 13]);
    expect(parseSemver("v1.2.3")).toEqual([1, 2, 3]);
  });

  test("rejects prerelease, partial, and garbage strings", () => {
    expect(parseSemver("1.2.3-beta.1")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("")).toBeNull();
    expect(parseSemver(undefined as unknown as string)).toBeNull();
  });

  test("compares numerically, not lexically", () => {
    expect(compareSemver("0.10.0", "0.9.0")).toBe(1);
    expect(compareSemver("4.150.9", "4.150.13")).toBe(-1);
    expect(compareSemver("4.150.13", "4.150.13")).toBe(0);
    expect(compareSemver("garbage", "1.0.0")).toBeNull();
  });
});

describe("shouldPromote", () => {
  const base = { candidateVersion: "4.151.0", nowMs: NOW, force: false };

  test("promotes when no manifest exists (first run / unreadable asset)", () => {
    expect(shouldPromote({ ...base, currentManifest: null }).promote).toBe(
      true,
    );
  });

  test("never regresses: skips when channel is newer, even forced", () => {
    const current = manifest("9.0.0", iso(THROTTLE_MS * 2));
    expect(shouldPromote({ ...base, currentManifest: current }).promote).toBe(
      false,
    );
    expect(
      shouldPromote({ ...base, currentManifest: current, force: true }).promote,
    ).toBe(false);
  });

  test("same version: idempotent skip, but force re-promotes (heal path)", () => {
    const current = manifest("4.151.0", iso(THROTTLE_MS * 2));
    expect(shouldPromote({ ...base, currentManifest: current }).promote).toBe(
      false,
    );
    expect(
      shouldPromote({ ...base, currentManifest: current, force: true }).promote,
    ).toBe(true);
  });

  test("force bypasses the throttle for a newer candidate", () => {
    const current = manifest("4.150.13", iso(60_000));
    expect(shouldPromote({ ...base, currentManifest: current }).promote).toBe(
      false,
    );
    expect(
      shouldPromote({ ...base, currentManifest: current, force: true }).promote,
    ).toBe(true);
  });

  test("fail-open: missing, unparseable, or FUTURE pub_date promotes", () => {
    for (const bad of [
      manifest("4.150.13"),
      manifest("4.150.13", "not a date"),
      manifest("4.150.13", new Date(NOW + 3_600_000).toISOString()),
    ]) {
      expect(shouldPromote({ ...base, currentManifest: bad }).promote).toBe(
        true,
      );
    }
  });

  test("throttles a fresh manifest, promotes a stale one", () => {
    const fresh = manifest("4.150.13", iso(THROTTLE_MS - 60_000));
    const stale = manifest("4.150.13", iso(THROTTLE_MS + 60_000));
    expect(shouldPromote({ ...base, currentManifest: fresh }).promote).toBe(
      false,
    );
    expect(shouldPromote({ ...base, currentManifest: stale }).promote).toBe(
      true,
    );
  });

  test("unparseable channel version falls through to the throttle branches", () => {
    const weird = manifest("not-a-version", iso(THROTTLE_MS * 2));
    expect(shouldPromote({ ...base, currentManifest: weird }).promote).toBe(
      true,
    );
  });
});

describe("buildLatestJson", () => {
  test("builds the exact updater contract shape", () => {
    const out = buildLatestJson({
      version: "4.151.0",
      signature: "c2lnbmF0dXJl\n",
      repo: "decocms/studio",
      pubDate: "2026-07-30T12:00:00Z",
    });
    expect(out).toEqual({
      version: "4.151.0",
      pub_date: "2026-07-30T12:00:00Z",
      notes: "https://github.com/decocms/studio/releases/tag/native-v4.151.0",
      platforms: {
        "darwin-aarch64": {
          url: "https://github.com/decocms/studio/releases/download/native-v4.151.0/deco-4.151.0-aarch64.app.tar.gz",
          signature: "c2lnbmF0dXJl",
        },
      },
    });
  });

  test("refuses unparseable versions and empty signatures", () => {
    expect(() =>
      buildLatestJson({
        version: "oops",
        signature: "sig",
        repo: "decocms/studio",
        pubDate: "2026-07-30T12:00:00Z",
      }),
    ).toThrow(/unparseable version/);
    expect(() =>
      buildLatestJson({
        version: "1.0.0",
        signature: "  ",
        repo: "decocms/studio",
        pubDate: "2026-07-30T12:00:00Z",
      }),
    ).toThrow(/signature/);
  });
});
