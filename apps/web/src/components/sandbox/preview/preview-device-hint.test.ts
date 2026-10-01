import { describe, expect, it } from "bun:test";
import {
  hintRendersApp,
  parsePreviewDeviceHint,
  previewDeviceHintBase,
  previewDeviceHintUrl,
} from "./preview-device-hint";

const HINT_URL = "https://app.example.com/.well-known/deco-preview.json";
const EITRI = { kind: "eitri-app" } as const;

const parse = (body: unknown, responseUrl = HINT_URL) =>
  parsePreviewDeviceHint({
    requestUrl: HINT_URL,
    responseUrl,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("previewDeviceHintBase", () => {
  it("reads the Local tunnel over the preview server", () => {
    expect(
      previewDeviceHintBase({
        localPreviewUrl: "https://localhost:3100/",
        previewServerUrl: "https://www.acme.com/",
      }),
    ).toBe("https://localhost:3100/");
  });

  it("falls back to the preview server, else nothing", () => {
    expect(
      previewDeviceHintBase({
        localPreviewUrl: null,
        previewServerUrl: "https://www.acme.com/",
      }),
    ).toBe("https://www.acme.com/");
    expect(
      previewDeviceHintBase({
        localPreviewUrl: "",
        previewServerUrl: undefined,
      }),
    ).toBeNull();
  });

  it("keeps the validation rules for a Local tunnel", () => {
    const base = previewDeviceHintBase({
      localPreviewUrl: "http://192.168.0.10:3100/",
      previewServerUrl: "https://www.acme.com/",
    });
    // A cleartext LAN tunnel is never asked, and never swapped for production.
    expect(previewDeviceHintUrl(base)).toBeNull();
    expect(
      previewDeviceHintUrl(
        previewDeviceHintBase({
          localPreviewUrl: "https://localhost:3100/some/page",
          previewServerUrl: null,
        }),
      ),
    ).toBe("https://localhost:3100/.well-known/deco-preview.json");
  });
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

  it("strips unknown fields (an older server's viewport included)", () => {
    expect(
      parse({ ...EITRI, viewport: { width: 390, height: 844 }, extra: 1 }),
    ).toEqual(EITRI);
  });

  it("rejects a missing or non-string kind", () => {
    expect(parse({ ...EITRI, kind: 42 })).toBeNull();
    expect(parse({ ...EITRI, kind: "" })).toBeNull();
    expect(parse({ ...EITRI, kind: "k".repeat(65) })).toBeNull();
    expect(parse({ device: "mobile" })).toBeNull();
  });

  it("treats only kind eitri-app as an app", () => {
    expect(hintRendersApp(EITRI)).toBe(true);
    expect(hintRendersApp({ kind: "storefront" })).toBe(false);
    expect(hintRendersApp(null)).toBe(false);
  });

  it("keeps only an eitri://workspace/<uuid> Eitri Play link", () => {
    const eitriPlay = "eitri://workspace/053076c1-9321-4109-a7e5-880b8b8e8376";
    expect(parse({ ...EITRI, eitriPlay })).toEqual({ ...EITRI, eitriPlay });
    for (const bad of [
      "https://evil.example/workspace/053076c1-9321-4109-a7e5-880b8b8e8376",
      `${eitriPlay}?next=https://evil.example`,
      "eitri://workspace/../../x",
      "javascript:alert(1)",
      42,
    ]) {
      // A bad link is dropped; the device hint itself still holds.
      expect(parse({ ...EITRI, eitriPlay: bad })).toEqual(EITRI);
    }
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
