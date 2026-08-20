import { describe, expect, test } from "bun:test";
import {
  assertPlatformCoverage,
  buildLatestJson,
  compareSemver,
  parseSemver,
  parseSigFilePairs,
  PLATFORM_ASSETS,
  shouldPromote,
  THROTTLE_MS,
} from "./native-update-channel.mjs";

const NOW = Date.parse("2026-07-30T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const manifest = (
  version: string,
  pubDate?: string,
  platforms: Record<string, object> = {
    "darwin-aarch64": {},
    "linux-x86_64": {},
  },
) => ({
  version,
  ...(pubDate !== undefined ? { pub_date: pubDate } : {}),
  platforms,
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
    const current = manifest("9.0.0", iso(THROTTLE_MS * 2), {
      "darwin-aarch64": {},
    });
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

  test("missing required platform bypasses the throttle", () => {
    const current = manifest("4.150.13", iso(60_000), {
      "darwin-aarch64": {},
    });
    expect(shouldPromote({ ...base, currentManifest: current })).toEqual({
      promote: true,
      reason: "channel missing required platform(s): linux-x86_64",
    });
  });

  test("missing required platform repairs the current version", () => {
    const current = manifest("4.151.0", iso(60_000), {
      "darwin-aarch64": {},
    });
    expect(shouldPromote({ ...base, currentManifest: current })).toEqual({
      promote: true,
      reason: "channel missing required platform(s): linux-x86_64",
    });
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

  test("throttles a fresh complete manifest, promotes a stale one", () => {
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
  const base = {
    version: "4.151.0",
    repo: "decocms/studio",
    pubDate: "2026-07-30T12:00:00Z",
  };
  const bothSigs = {
    "darwin-aarch64": "ZGFyd2lu\n",
    "linux-x86_64": "  bGludXg=  ",
  };

  test("builds the exact updater contract shape for every platform", () => {
    expect(buildLatestJson({ ...base, signatures: bothSigs })).toEqual({
      version: "4.151.0",
      pub_date: "2026-07-30T12:00:00Z",
      notes: "https://github.com/decocms/studio/releases/tag/native-v4.151.0",
      platforms: {
        "darwin-aarch64": {
          url: "https://github.com/decocms/studio/releases/download/native-v4.151.0/deco-4.151.0-aarch64.app.tar.gz",
          signature: "ZGFyd2lu",
        },
        "linux-x86_64": {
          url: "https://github.com/decocms/studio/releases/download/native-v4.151.0/deco-4.151.0-linux-x86_64.AppImage.tar.gz",
          signature: "bGludXg=",
        },
      },
    });
  });

  test("covers exactly the platforms the release ships", () => {
    expect(Object.keys(PLATFORM_ASSETS)).toEqual([
      "darwin-aarch64",
      "linux-x86_64",
    ]);
  });

  test("refuses unparseable versions", () => {
    expect(() =>
      buildLatestJson({ ...base, version: "oops", signatures: bothSigs }),
    ).toThrow(/unparseable version/);
  });

  test("refuses a manifest missing any platform's signature", () => {
    expect(() =>
      buildLatestJson({
        ...base,
        signatures: { "darwin-aarch64": bothSigs["darwin-aarch64"] },
      }),
    ).toThrow(/missing updater signature contents for linux-x86_64/);
    expect(() =>
      buildLatestJson({
        ...base,
        signatures: { "linux-x86_64": bothSigs["linux-x86_64"] },
      }),
    ).toThrow(/missing updater signature contents for darwin-aarch64/);
    expect(() => buildLatestJson({ ...base, signatures: {} })).toThrow(
      /darwin-aarch64, linux-x86_64/,
    );
  });

  test("refuses empty and whitespace-only signatures", () => {
    for (const empty of ["", "  ", "\n\t "]) {
      expect(() =>
        buildLatestJson({
          ...base,
          signatures: { ...bothSigs, "linux-x86_64": empty },
        }),
      ).toThrow(/missing updater signature contents for linux-x86_64/);
    }
  });

  test("refuses unknown platform keys and non-object signatures", () => {
    expect(() =>
      buildLatestJson({
        ...base,
        signatures: { ...bothSigs, "linux-amd64": "c2ln" },
      }),
    ).toThrow(/unknown platform key\(s\) linux-amd64/);
    expect(() =>
      buildLatestJson({
        ...base,
        signatures: { ...bothSigs, toString: "c2ln" },
      }),
    ).toThrow(/unknown platform key\(s\) toString/);
    expect(() =>
      buildLatestJson({
        ...base,
        signatures: "c2ln" as unknown as Record<string, string>,
      }),
    ).toThrow(/must be an object/);
  });
});

describe("parseSigFilePairs", () => {
  test("accumulates one pair per repeated flag", () => {
    expect(
      parseSigFilePairs([
        "darwin-aarch64=/tmp/mac.sig",
        "linux-x86_64=/tmp/linux.sig",
      ]),
    ).toEqual({
      "darwin-aarch64": "/tmp/mac.sig",
      "linux-x86_64": "/tmp/linux.sig",
    });
    expect(parseSigFilePairs([])).toEqual({});
  });

  test("keeps `=` inside the path, splitting on the first one only", () => {
    expect(parseSigFilePairs(["linux-x86_64=/tmp/a=b.sig"])).toEqual({
      "linux-x86_64": "/tmp/a=b.sig",
    });
  });

  test("rejects malformed pairs instead of dropping a platform", () => {
    for (const bad of [
      "/tmp/mac.sig",
      "darwin-aarch64",
      "darwin-aarch64=",
      "=/tmp/mac.sig",
      undefined as unknown as string,
    ]) {
      expect(() => parseSigFilePairs([bad])).toThrow(/malformed --sig-file/);
    }
  });

  test("rejects a duplicated platform rather than silently overwriting", () => {
    expect(() =>
      parseSigFilePairs(["linux-x86_64=/tmp/a.sig", "linux-x86_64=/tmp/b.sig"]),
    ).toThrow(/duplicate --sig-file for platform linux-x86_64/);
  });
});

describe("assertPlatformCoverage", () => {
  const withPlatforms = (...keys: string[]) => ({
    platforms: Object.fromEntries(
      keys.map((k) => [k, { url: "", signature: "" }]),
    ),
  });

  test("accepts an equal or wider platform set", () => {
    expect(() =>
      assertPlatformCoverage({
        nextManifest: withPlatforms("darwin-aarch64", "linux-x86_64"),
        currentManifest: withPlatforms("darwin-aarch64", "linux-x86_64"),
      }),
    ).not.toThrow();
    expect(() =>
      assertPlatformCoverage({
        nextManifest: withPlatforms("darwin-aarch64", "linux-x86_64"),
        currentManifest: withPlatforms("darwin-aarch64"),
      }),
    ).not.toThrow();
  });

  test("rejects a strict subset — the silent-strand regression", () => {
    expect(() =>
      assertPlatformCoverage({
        nextManifest: withPlatforms("darwin-aarch64"),
        currentManifest: withPlatforms("darwin-aarch64", "linux-x86_64"),
      }),
    ).toThrow(/dropping platform\(s\) linux-x86_64/);
  });

  test("fails open on an absent or shapeless published manifest", () => {
    for (const current of [null, {}, { platforms: null }, "garbage"]) {
      expect(() =>
        assertPlatformCoverage({
          nextManifest: withPlatforms("darwin-aarch64"),
          currentManifest: current as unknown as object,
        }),
      ).not.toThrow();
    }
  });

  test("fails closed on a candidate with no platforms at all", () => {
    for (const next of [{}, { platforms: {} }, null]) {
      expect(() =>
        assertPlatformCoverage({
          nextManifest: next as unknown as object,
          currentManifest: withPlatforms("darwin-aarch64"),
        }),
      ).toThrow(/no platforms/);
    }
  });
});
