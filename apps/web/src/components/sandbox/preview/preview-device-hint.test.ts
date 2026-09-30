import { describe, expect, it } from "bun:test";
import {
  parsePreviewDeviceHint,
  previewDeviceHintBadgeKey,
  previewDeviceHintUrl,
  resolveDefaultPreviewDevice,
} from "./preview-device-hint";

const HINT_URL = "https://app.example.com/.well-known/deco-preview.json";
const EITRI = {
  kind: "eitri-app",
  device: "mobile",
  viewport: { width: 390, height: 844 },
} as const;

const parse = (body: unknown, responseUrl = HINT_URL) =>
  parsePreviewDeviceHint({
    requestUrl: HINT_URL,
    responseUrl,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("previewDeviceHintUrl", () => {
  it("targets the well-known path on the preview server's own origin", () => {
    expect(previewDeviceHintUrl("https://app.example.com/pdp/123?x=1")).toBe(
      HINT_URL,
    );
    expect(previewDeviceHintUrl("https://localhost:3100")).toBe(
      "https://localhost:3100/.well-known/deco-preview.json",
    );
    expect(previewDeviceHintUrl("http://127.0.0.1:3100/")).toBe(
      "http://127.0.0.1:3100/.well-known/deco-preview.json",
    );
  });

  it("does not ask cleartext non-loopback servers, or nothing at all", () => {
    expect(previewDeviceHintUrl("http://app.example.com")).toBeNull();
    expect(previewDeviceHintUrl("ftp://localhost")).toBeNull();
    expect(previewDeviceHintUrl("")).toBeNull();
    expect(previewDeviceHintUrl(null)).toBeNull();
  });
});

describe("parsePreviewDeviceHint", () => {
  it("accepts the documented hint", () => {
    expect(parse(EITRI)).toEqual(EITRI);
  });

  it("accepts a hint without viewport and strips unknown fields", () => {
    expect(parse({ kind: "site", device: "desktop", extra: { a: 1 } })).toEqual(
      { kind: "site", device: "desktop" },
    );
  });

  it("rejects an unknown device or a non-string kind", () => {
    expect(parse({ ...EITRI, device: "tablet" })).toBeNull();
    expect(parse({ ...EITRI, kind: 42 })).toBeNull();
    expect(parse({ ...EITRI, kind: "" })).toBeNull();
    expect(parse({ ...EITRI, kind: "k".repeat(65) })).toBeNull();
    expect(parse({ device: "mobile" })).toBeNull();
  });

  it("rejects viewports outside sane integer bounds", () => {
    expect(
      parse({ ...EITRI, viewport: { width: 100, height: 844 } }),
    ).toBeNull();
    expect(
      parse({ ...EITRI, viewport: { width: 390, height: 40000 } }),
    ).toBeNull();
    expect(
      parse({ ...EITRI, viewport: { width: 390.5, height: 844 } }),
    ).toBeNull();
  });

  it("rejects oversized and malformed bodies", () => {
    expect(parse({ ...EITRI, pad: "x".repeat(4096) })).toBeNull();
    expect(parse("<!doctype html><html></html>")).toBeNull();
    expect(parse("")).toBeNull();
    expect(parse("null")).toBeNull();
  });

  it("rejects an answer from another origin", () => {
    expect(
      parse(EITRI, "https://evil.example.net/.well-known/deco-preview.json"),
    ).toBeNull();
    expect(
      parse(EITRI, "http://app.example.com/.well-known/deco-preview.json"),
    ).toBeNull();
    expect(parse(EITRI, "")).toBeNull();
  });
});

describe("resolveDefaultPreviewDevice", () => {
  it("prefers the explicit setting over the hint", () => {
    expect(
      resolveDefaultPreviewDevice({ explicit: "desktop", hint: EITRI }),
    ).toBe("desktop");
    expect(
      resolveDefaultPreviewDevice({
        explicit: "mobile",
        hint: { kind: "site", device: "desktop" },
      }),
    ).toBe("mobile");
  });

  it("follows the hint when automatic, else desktop", () => {
    expect(resolveDefaultPreviewDevice({ explicit: null, hint: EITRI })).toBe(
      "mobile",
    );
    expect(
      resolveDefaultPreviewDevice({ explicit: undefined, hint: null }),
    ).toBe("desktop");
  });
});

describe("previewDeviceHintBadgeKey", () => {
  it("names Eitri apps, other mobile previews, and nothing otherwise", () => {
    expect(previewDeviceHintBadgeKey(EITRI)).toBe(
      "sandbox.preview.deviceHintEitriApp",
    );
    expect(
      previewDeviceHintBadgeKey({ kind: "rn-web", device: "mobile" }),
    ).toBe("sandbox.preview.deviceHintMobile");
    expect(
      previewDeviceHintBadgeKey({ kind: "site", device: "desktop" }),
    ).toBeNull();
    expect(previewDeviceHintBadgeKey(null)).toBeNull();
  });
});
