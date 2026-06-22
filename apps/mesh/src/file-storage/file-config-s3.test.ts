import { afterEach, describe, expect, mock, test } from "bun:test";
import { buildPublicUrl, stsCredentialProvider } from "./file-config-s3";
import type { FileConfigInfo } from "../storage/types";

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

  test("throws when refreshUrl is missing", () => {
    expect(() => stsCredentialProvider(info({}), "k")).toThrow(
      /missing a refreshUrl/,
    );
  });
});
