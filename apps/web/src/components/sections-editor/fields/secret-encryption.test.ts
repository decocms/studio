import { afterEach, describe, expect, test } from "bun:test";
import {
  encryptSiteSecret,
  secretEncryptionSiteUrls,
} from "./secret-encryption";
import { startSecretSite } from "./secret-site-server";

const RAW = "SG.synthetic-raw-api-key_0123456789";

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

async function site(mode?: Parameters<typeof startSecretSite>[0]) {
  const s = await startSecretSite(mode);
  stops.push(s.stop);
  return s;
}

describe("secretEncryptionSiteUrls", () => {
  test("prefers the site's deco.site host, then the preview server, deduped", () => {
    expect(
      secretEncryptionSiteUrls({
        siteSlug: "acme",
        previewServerUrl: "https://www.acme.com/",
      }),
    ).toEqual(["https://acme.deco.site/", "https://www.acme.com/"]);
    expect(
      secretEncryptionSiteUrls({
        siteSlug: "acme",
        previewServerUrl: "https://acme.deco.site/",
      }),
    ).toEqual(["https://acme.deco.site/"]);
  });

  test("skips loopback hosts whose key production can't decrypt", () => {
    expect(
      secretEncryptionSiteUrls({
        siteSlug: null,
        previewServerUrl: "https://localhost:3100/",
      }),
    ).toEqual([]);
  });
});

describe("encryptSiteSecret", () => {
  test("POSTs the value in the body and returns hex the site can decrypt", async () => {
    const s = await site();
    const hex = await encryptSiteSecret(RAW, [s.url]);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(await s.decrypt(hex)).toBe(RAW);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.method).toBe("POST");
    expect(s.requests[0]!.url).not.toContain(encodeURIComponent(RAW));
    expect(JSON.parse(s.requests[0]!.body)).toEqual({ value: RAW });
  });

  test("falls back to the $live action key on older sites", async () => {
    const s = await site("legacy-only");
    const hex = await encryptSiteSecret(RAW, [s.url]);
    expect(await s.decrypt(hex)).toBe(RAW);
  });

  test("falls back to the next site URL when the first is down", async () => {
    const down = await site("fail");
    const up = await site();
    const hex = await encryptSiteSecret(RAW, [down.url, up.url]);
    expect(await up.decrypt(hex)).toBe(RAW);
  });

  test("throws instead of returning plaintext", async () => {
    const failing = await site("fail");
    await expect(encryptSiteSecret(RAW, [failing.url])).rejects.toThrow();
    const echo = await site("echo");
    await expect(encryptSiteSecret(RAW, [echo.url])).rejects.toThrow();
    await expect(encryptSiteSecret(RAW, [])).rejects.toThrow();
  });
});
