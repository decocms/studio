import { describe, expect, test } from "bun:test";
import {
  androidIntentUrl,
  appPlatform,
  draftSlug,
  isAppProtocol,
  isHttpsUrl,
  mobileAppConfig,
  mobileAppLink,
  openAppUrl,
  parseOpenAppParams,
} from "./mobile-app.ts";

const SLUG = "AbC_123-xyzAbC_123-xyz";
const POINTER = `delivery.decocms.com/sites/newbalance-app/drafts/${SLUG}/index.json@e3f1`;
const NB = {
  protocol: "newbalance",
  iosInstallUrl: "https://testflight.apple.com/join/B9wsWdMp",
  androidInstallUrl: "https://appdistribution.firebase.dev/i/ec47da3cc852f630",
};

describe("mobileAppConfig", () => {
  test("on while metadata.mobileApp is an object", () => {
    expect(mobileAppConfig({ mobileApp: NB })).toEqual(NB);
    expect(mobileAppConfig({ mobileApp: {} })).toEqual({ protocol: "" });
  });

  test("blank or non-string fields read as absent", () => {
    expect(
      mobileAppConfig({
        mobileApp: {
          protocol: " nb ",
          iosInstallUrl: "",
          androidInstallUrl: 1,
        },
      }),
    ).toEqual({ protocol: "nb" });
  });

  test("off otherwise", () => {
    for (const metadata of [
      {},
      { mobileApp: null },
      { mobileApp: true },
      { mobileApp: "newbalance" },
      { mobileApp: [] },
      null,
      undefined,
    ]) {
      expect(mobileAppConfig(metadata)).toBeNull();
    }
  });
});

describe("draftSlug", () => {
  test("the folder of a v8 draft pointer", () => {
    expect(draftSlug(POINTER)).toBe(SLUG);
    expect(
      draftSlug(
        "delivery.decocms.com/sites/a/drafts/s1/index.json?__variant=x@e3",
      ),
    ).toBe("s1");
  });

  test("null for anything else", () => {
    for (const pointer of [
      null,
      undefined,
      "",
      "off",
      "studio.decocms.com/api/decofile/x@sha",
      "delivery.decocms.com/sites/a/revisions/r1/index.json",
      "delivery.decocms.com/sites/a/drafts/s1/Hero.json@e3",
    ]) {
      expect(draftSlug(pointer)).toBeNull();
    }
  });
});

describe("mobileAppLink", () => {
  test("the Dev build's scheme and the page, encoded", () => {
    expect(
      mobileAppLink({
        protocol: "newbalance",
        slug: SLUG,
        path: "/lancamento-983",
      }),
    ).toBe(`newbalance-dev://account/StudioPreview/${SLUG}/%2Flancamento-983`);
    expect(
      mobileAppLink({ protocol: "newbalance", slug: SLUG, path: "/" }),
    ).toBe(`newbalance-dev://account/StudioPreview/${SLUG}/%2F`);
    expect(
      mobileAppLink({ protocol: "newbalance", slug: SLUG, path: "" }),
    ).toBe(`newbalance-dev://account/StudioPreview/${SLUG}/`);
  });
});

describe("validators", () => {
  test("isAppProtocol: a lowercase scheme name", () => {
    for (const ok of ["newbalance", "fila", "my.app+v2", "a-b"]) {
      expect(isAppProtocol(ok)).toBe(true);
    }
    for (const bad of [
      "",
      "NewBalance",
      "1nb",
      "nb://",
      "nb:x",
      "nb/x",
      "nb x",
      undefined,
      42,
    ]) {
      expect(isAppProtocol(bad)).toBe(false);
    }
  });

  test("isHttpsUrl: https only", () => {
    expect(isHttpsUrl(NB.iosInstallUrl)).toBe(true);
    for (const url of [
      "http://testflight.apple.com",
      "javascript:alert(1)",
      "newbalance-dev://x",
      "not a url",
      undefined,
    ]) {
      expect(isHttpsUrl(url)).toBe(false);
    }
  });
});

describe("the bridge page", () => {
  const params = {
    protocol: "newbalance",
    slug: SLUG,
    path: "/lancamento-983",
    ios: NB.iosInstallUrl,
    apk: NB.androidInstallUrl,
  };

  test("openAppUrl round-trips through parseOpenAppParams", () => {
    const url = new URL(openAppUrl("https://studio.decocms.com", params));
    expect(url.origin + url.pathname).toBe(
      "https://studio.decocms.com/open-app",
    );
    expect(parseOpenAppParams(Object.fromEntries(url.searchParams))).toEqual(
      params,
    );
  });

  test("openAppUrl leaves out install pages that aren't https", () => {
    const url = new URL(
      openAppUrl("https://studio.decocms.com", {
        ...params,
        ios: "http://insecure.example",
        apk: undefined,
      }),
    );
    expect([...url.searchParams.keys()]).toEqual(["protocol", "slug", "path"]);
  });

  test("parseOpenAppParams refuses anything that is not what its name says", () => {
    expect(parseOpenAppParams({ protocol: "nb", slug: "s1" })).toEqual({
      protocol: "nb",
      slug: "s1",
      path: "",
    });
    for (const search of [
      {},
      { slug: "s1" },
      { protocol: "javascript:alert(1)//", slug: "s1" },
      { protocol: "https://evil.example", slug: "s1" },
      { protocol: "nb", slug: "../x" },
      { protocol: "nb", slug: "a/b" },
      { protocol: "nb", slug: "s1", path: 1 },
      { protocol: "nb", slug: "s1", ios: "javascript:alert(1)" },
      { protocol: "nb", slug: "s1", apk: "http://x.example/app.apk" },
    ]) {
      expect(parseOpenAppParams(search)).toBeNull();
    }
  });

  test("androidIntentUrl: the Dev scheme, no package, the apk as fallback", () => {
    expect(androidIntentUrl(params)).toBe(
      `intent://account/StudioPreview/${SLUG}/%2Flancamento-983#Intent;scheme=newbalance-dev;S.browser_fallback_url=${encodeURIComponent(NB.androidInstallUrl)};end`,
    );
    expect(androidIntentUrl({ protocol: "nb", slug: "s1", path: "/" })).toBe(
      "intent://account/StudioPreview/s1/%2F#Intent;scheme=nb-dev;end",
    );
  });

  test("appPlatform", () => {
    expect(
      appPlatform(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36",
      ),
    ).toBe("android");
    expect(
      appPlatform(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      ),
    ).toBe("ios");
    const mac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15";
    expect(appPlatform(mac, 5)).toBe("ios");
    expect(appPlatform(mac, 0)).toBe("desktop");
    expect(
      appPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131"),
    ).toBe("desktop");
  });
});
