import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  buildPublicUrl,
  buildS3Client,
  byLastModifiedDesc,
  isImageKey,
  type ListedObject,
  matchScanPage,
  monthShardPrefixes,
  nextScanStep,
  type ScanCandidate,
  stsCredentialProvider,
} from "./file-config-s3";
import type { FileConfigInfo } from "../storage/types";
import { buildObjectKey } from "./upload-policy";

function info(overrides: Partial<FileConfigInfo>): FileConfigInfo {
  return {
    id: "fcfg_test",
    organizationId: "org_test",
    name: "test",
    description: null,
    bucket: "my-bucket",
    region: "us-east-1",
    endpoint: null,
    forcePathStyle: false,
    prefix: null,
    publicUrlBase: null,
    credentialType: "static",
    refreshUrl: null,
    siteSlug: null,
    createdBy: "u",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "u",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildPublicUrl", () => {
  test("publicUrlBase wins", () => {
    expect(
      buildPublicUrl(
        info({ publicUrlBase: "https://cdn.example.com" }),
        "foo/bar.png",
      ),
    ).toBe("https://cdn.example.com/foo/bar.png");
  });

  test("AWS virtual-host style by default", () => {
    expect(buildPublicUrl(info({}), "logo.png")).toBe(
      "https://my-bucket.s3.us-east-1.amazonaws.com/logo.png",
    );
  });

  test("AWS path-style when forcePathStyle is set", () => {
    expect(buildPublicUrl(info({ forcePathStyle: true }), "logo.png")).toBe(
      "https://s3.us-east-1.amazonaws.com/my-bucket/logo.png",
    );
  });

  test("custom endpoint always uses path-style (forcePathStyle: true)", () => {
    expect(
      buildPublicUrl(
        info({
          endpoint: "https://account.r2.cloudflarestorage.com",
          forcePathStyle: true,
        }),
        "x.png",
      ),
    ).toBe("https://account.r2.cloudflarestorage.com/my-bucket/x.png");
  });

  test("custom endpoint always uses path-style (forcePathStyle: false)", () => {
    // Virtual-host style isn't derivable from endpoint+bucket on
    // non-AWS providers — callers should set publicUrlBase to override.
    expect(
      buildPublicUrl(
        info({
          endpoint: "https://account.r2.cloudflarestorage.com",
          forcePathStyle: false,
        }),
        "x.png",
      ),
    ).toBe("https://account.r2.cloudflarestorage.com/my-bucket/x.png");
  });

  test("percent-encodes path segments but keeps slashes", () => {
    expect(buildPublicUrl(info({}), "folder/with spaces/é.png")).toBe(
      "https://my-bucket.s3.us-east-1.amazonaws.com/folder/with%20spaces/%C3%A9.png",
    );
  });
});

describe("isImageKey", () => {
  test("matches common image extensions case-insensitively", () => {
    for (const key of [
      "a.png",
      "b.JPG",
      "c/d.jpeg",
      "e.webp",
      "f.SVG",
      "g.avif",
    ]) {
      expect(isImageKey(key)).toBe(true);
    }
  });

  test("rejects non-image and extensionless keys", () => {
    for (const key of ["a.pdf", "b.docx", "c.png.txt", "folder/", "noext"]) {
      expect(isImageKey(key)).toBe(false);
    }
  });
});

describe("monthShardPrefixes", () => {
  test("lists months newest-first, crossing the year boundary", () => {
    // 2026-02 walking back 4 months -> Feb, Jan 2026, Dec, Nov 2025.
    expect(
      monthShardPrefixes("uploads/", new Date("2026-02-15T00:00:00Z"), 4),
    ).toEqual([
      "uploads/2026/02/",
      "uploads/2026/01/",
      "uploads/2025/12/",
      "uploads/2025/11/",
    ]);
  });

  test("zero-pads the month to match buildObjectKey's yyyy/mm shard", () => {
    expect(monthShardPrefixes("", new Date("2026-08-13T18:44:00Z"), 1)).toEqual(
      ["2026/08/"],
    );
  });

  test("uses UTC (keys are UTC-stamped) to derive the month", () => {
    expect(monthShardPrefixes("", new Date("2026-09-01T00:30:00Z"), 2)).toEqual(
      ["2026/09/", "2026/08/"],
    );
  });

  test("count of zero yields no probes", () => {
    expect(
      monthShardPrefixes("p/", new Date("2026-08-13T00:00:00Z"), 0),
    ).toEqual([]);
  });

  test("January is followed by the previous December (immediate wrap)", () => {
    expect(
      monthShardPrefixes("p/", new Date("2026-01-01T00:00:00Z"), 2),
    ).toEqual(["p/2026/01/", "p/2025/12/"]);
  });

  test("walks back across multiple years for large counts", () => {
    // Guards the year-decrement wrap when count exceeds 12 months.
    expect(
      monthShardPrefixes("", new Date("2026-01-15T00:00:00Z"), 14),
    ).toEqual([
      "2026/01/",
      "2025/12/",
      "2025/11/",
      "2025/10/",
      "2025/09/",
      "2025/08/",
      "2025/07/",
      "2025/06/",
      "2025/05/",
      "2025/04/",
      "2025/03/",
      "2025/02/",
      "2025/01/",
      "2024/12/",
    ]);
  });

  test("a fresh key's shard matches its month's probe (no drift vs buildObjectKey)", () => {
    const key = buildObjectKey({ prefix: "uploads/", filename: "photo.png" });
    const [probe] = monthShardPrefixes("uploads/", new Date(), 1);
    expect(key.startsWith(probe!)).toBe(true);
  });
});

describe("byLastModifiedDesc", () => {
  const obj = (key: string, lastModified: string | null): ListedObject => ({
    key,
    size: 1,
    lastModified,
    publicUrl: `https://cdn/${key}`,
  });

  test("orders newest first regardless of key order", () => {
    // A fresh upload with a lexicographically-late UUID must still sort first.
    const items = [
      obj("2026/08/aaa.png", "2026-08-01T00:00:00.000Z"),
      obj("2026/08/eee.png", "2026-08-14T09:53:00.000Z"),
      obj("2026/08/ccc.png", "2026-08-10T00:00:00.000Z"),
    ];
    expect(
      items
        .slice()
        .sort(byLastModifiedDesc)
        .map((i) => i.key),
    ).toEqual(["2026/08/eee.png", "2026/08/ccc.png", "2026/08/aaa.png"]);
  });

  test("sinks null lastModified to the bottom", () => {
    const items = [
      obj("a", null),
      obj("b", "2026-08-14T00:00:00.000Z"),
      obj("c", null),
    ];
    const sorted = items.slice().sort(byLastModifiedDesc);
    expect(sorted[0]?.key).toBe("b");
    expect(sorted.slice(1).map((i) => i.lastModified)).toEqual([null, null]);
  });
});

describe("matchScanPage", () => {
  const page: ScanCandidate[] = [
    { key: "2026/07/uuid-report.pdf", size: 1, lastModified: null },
    { key: "2026/07/uuid-Report.png", size: 2, lastModified: null },
    { key: "2026/07/uuid-invoice.jpg", size: 3, lastModified: null },
  ];

  test("substring match is case-insensitive on the full key", () => {
    const hits = matchScanPage(page, "report", false).map((c) => c.key);
    expect(hits).toEqual([
      "2026/07/uuid-report.pdf",
      "2026/07/uuid-Report.png",
    ]);
  });

  test("imageOnly drops non-image matches", () => {
    const hits = matchScanPage(page, "report", true).map((c) => c.key);
    expect(hits).toEqual(["2026/07/uuid-Report.png"]);
  });

  test("no matches returns empty", () => {
    expect(matchScanPage(page, "nope", false)).toEqual([]);
  });
});

describe("nextScanStep", () => {
  const base = {
    target: 50,
    pagesScanned: 1,
    maxPages: 20,
    isTruncated: true,
    continuationToken: "tok",
  };

  test("continues when under target and more pages remain", () => {
    expect(nextScanStep({ ...base, matchCount: 10 })).toEqual({
      done: false,
      nextCursor: "tok",
    });
  });

  test("stops once target is reached, keeping the resume cursor", () => {
    // Enough matches to stop, but the bucket still has unscanned keys — the
    // cursor must be handed back so "Load more" resumes without dropping them.
    expect(nextScanStep({ ...base, matchCount: 50 })).toEqual({
      done: true,
      nextCursor: "tok",
    });
  });

  test("stops with null cursor when the bucket is exhausted", () => {
    expect(
      nextScanStep({
        ...base,
        matchCount: 3,
        isTruncated: false,
        continuationToken: undefined,
      }),
    ).toEqual({ done: true, nextCursor: null });
  });

  test("stops at the page budget but preserves the resume cursor", () => {
    expect(nextScanStep({ ...base, matchCount: 0, pagesScanned: 20 })).toEqual({
      done: true,
      nextCursor: "tok",
    });
  });

  test("truncated without a token is treated as exhausted", () => {
    expect(
      nextScanStep({
        ...base,
        matchCount: 0,
        isTruncated: true,
        continuationToken: undefined,
      }),
    ).toEqual({ done: true, nextCursor: null });
  });
});

describe("stsCredentialProvider", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const stsInfo = info({
    credentialType: "sts-session",
    refreshUrl: "https://admin.example.com/api/acme/s3-credentials",
  });

  test("posts to refreshUrl with the api key and maps the response", async () => {
    const seen: { url?: string; headers?: Headers } = {};
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.headers = new Headers(init.headers);
      return new Response(
        JSON.stringify({
          accessKeyId: "AKIA",
          secretAccessKey: "secret",
          sessionToken: "token",
          expiration: "2026-06-19T00:00:00.000Z",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const creds = await stsCredentialProvider(stsInfo, "api-key-123")();

    expect(seen.url).toBe("https://admin.example.com/api/acme/s3-credentials");
    expect(seen.headers?.get("x-api-key")).toBe("api-key-123");
    expect(creds.accessKeyId).toBe("AKIA");
    expect(creds.sessionToken).toBe("token");
    expect(creds.expiration).toEqual(new Date("2026-06-19T00:00:00.000Z"));
  });

  test("throws when the refresh call fails", async () => {
    globalThis.fetch = mock(
      async () => new Response("nope", { status: 403 }),
    ) as unknown as typeof fetch;
    expect(stsCredentialProvider(stsInfo, "k")()).rejects.toThrow(
      /sts refresh failed \(403\)/,
    );
  });

  test("throws when the response is missing the session token", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({ accessKeyId: "AKIA", secretAccessKey: "s" }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    expect(stsCredentialProvider(stsInfo, "k")()).rejects.toThrow(
      /incomplete credentials/,
    );
  });

  test("throws when the response's expiration is not a valid date", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            accessKeyId: "AKIA",
            secretAccessKey: "s",
            sessionToken: "t",
            expiration: "not-a-date",
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    expect(stsCredentialProvider(stsInfo, "k")()).rejects.toThrow(
      /invalid expiration/,
    );
  });

  test("throws when refreshUrl is missing", () => {
    expect(() => stsCredentialProvider(info({}), "k")).toThrow(
      /missing a refreshUrl/,
    );
  });
});

describe("buildS3Client", () => {
  test("throws when region is empty", () => {
    expect(() =>
      buildS3Client({
        info: info({ region: "" }),
        credentials: {
          type: "static",
          accessKeyId: "AKIA",
          secretAccessKey: "secret",
        },
      }),
    ).toThrow(/missing or empty region/);
  });

  test("throws when bucket is empty", () => {
    expect(() =>
      buildS3Client({
        info: info({ bucket: "" }),
        credentials: {
          type: "static",
          accessKeyId: "AKIA",
          secretAccessKey: "secret",
        },
      }),
    ).toThrow(/missing or empty bucket/);
  });

  test("throws when static credentials lack accessKeyId", () => {
    expect(() =>
      buildS3Client({
        info: info({}),
        credentials: {
          type: "static",
          accessKeyId: "",
          secretAccessKey: "secret",
        },
      }),
    ).toThrow(/missing or empty accessKeyId/);
  });

  test("throws when static credentials lack secretAccessKey", () => {
    expect(() =>
      buildS3Client({
        info: info({}),
        credentials: {
          type: "static",
          accessKeyId: "AKIA",
          secretAccessKey: "",
        },
      }),
    ).toThrow(/missing or empty secretAccessKey/);
  });

  test("throws when managed config lacks siteSlug", () => {
    expect(() =>
      buildS3Client({
        info: info({ siteSlug: null }),
        credentials: { type: "managed" },
      }),
    ).toThrow(/missing siteSlug/);
  });
});
