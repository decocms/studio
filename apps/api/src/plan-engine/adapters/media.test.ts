import { describe, expect, test } from "bun:test";
import { createBoundObjectStorage } from "@/object-storage/bound-object-storage";
import { S3Service } from "@/object-storage/s3-service";
import { mediaViewSigner, viewWindow, withMediaUrls } from "./media.ts";

// Signing is local: no request reaches this endpoint.
const s3 = new S3Service({
  endpoint: "https://storage.example",
  bucket: "media",
  region: "us-east-1",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
  forcePathStyle: true,
});
const storage = createBoundObjectStorage(s3, "org_a");

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 25, 12, 0, 0);

describe("viewWindow", () => {
  test("a URL lasts at least an hour from now, signed at the last 10 minutes", () => {
    for (const offset of [0, 1, 9 * MINUTE + 59_000]) {
      const now = T0 + offset;
      const { signedAt, expiresIn } = viewWindow(now);
      expect(signedAt.getTime()).toBe(T0);
      expect(signedAt.getTime() + expiresIn * 1000 - now).toBeGreaterThan(
        60 * MINUTE - 1000,
      );
    }
    expect(viewWindow(T0 + 10 * MINUTE).signedAt.getTime()).toBe(
      T0 + 10 * MINUTE,
    );
  });
});

describe("mediaViewSigner", () => {
  test("polls within 10 minutes get the same URL; the next window, another", async () => {
    let now = T0 + MINUTE;
    const sign = mediaViewSigner(storage, () => now);
    const first = await sign("ux/d1/pdp/mobile-fold.jpg");
    now = T0 + 8 * MINUTE;
    expect(await sign("ux/d1/pdp/mobile-fold.jpg")).toBe(first);
    now = T0 + 11 * MINUTE;
    expect(await sign("ux/d1/pdp/mobile-fold.jpg")).not.toBe(first);

    const url = new URL(first);
    expect(url.pathname).toBe(
      "/media/org_a/plan-engine/ux/d1/pdp/mobile-fold.jpg",
    );
    expect(url.searchParams.get("X-Amz-Date")).toBe("20261125T120000Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("4200");
  });

  test("refuses a path that climbs out of the engine's prefix", async () => {
    const sign = mediaViewSigner(storage);
    await expect(sign("ux/../secrets.jpg")).rejects.toThrow(
      /invalid media path/,
    );
  });
});

describe("withMediaUrls", () => {
  const sign = async (path: string) => `https://cdn.example/${path}?sig=1`;

  test("signs every engine image path, wherever it sits, and nothing else", async () => {
    const value = {
      pages: [
        {
          capture_url: "ux/d1/pdp/mobile-fold.jpg",
          evidence: {
            captures: [
              {
                fold_url: "ux/d1/pdp/desktop-fold.jpg",
                full_url: "ux/d1/pdp/desktop-full.jpg",
              },
            ],
            design_system: {
              buy_box_url: "ux/design-system/2026-11-25/buy-box.jpg",
            },
          },
        },
      ],
      verification: {
        screenshot: "ux/d1/run2/verify/d1:o1:h1-c1.jpg",
        benchmark: "ux/benchmark/2026-11-25/www.rival.example-full.jpg",
      },
      untouched: [
        "ux/d1/repo.json",
        "https://www.loja.example/produto.jpg",
        "Veja ux/d1/pdp/mobile-fold.jpg",
        "",
        null,
        3,
        true,
      ],
    };
    expect(await withMediaUrls(value, sign)).toEqual({
      pages: [
        {
          capture_url: "https://cdn.example/ux/d1/pdp/mobile-fold.jpg?sig=1",
          evidence: {
            captures: [
              {
                fold_url:
                  "https://cdn.example/ux/d1/pdp/desktop-fold.jpg?sig=1",
                full_url:
                  "https://cdn.example/ux/d1/pdp/desktop-full.jpg?sig=1",
              },
            ],
            design_system: {
              buy_box_url:
                "https://cdn.example/ux/design-system/2026-11-25/buy-box.jpg?sig=1",
            },
          },
        },
      ],
      verification: {
        screenshot:
          "https://cdn.example/ux/d1/run2/verify/d1:o1:h1-c1.jpg?sig=1",
        benchmark:
          "https://cdn.example/ux/benchmark/2026-11-25/www.rival.example-full.jpg?sig=1",
      },
      untouched: value.untouched,
    });
  });

  test("signs a repeated path once", async () => {
    let calls = 0;
    const counting = async (path: string) => {
      calls++;
      return `https://cdn.example/${path}`;
    };
    const path = "ux/d1/pdp/mobile-fold.jpg";
    await withMediaUrls({ a: path, b: [path, { c: path }] }, counting);
    expect(calls).toBe(1);
  });

  test("a path that fails to sign stays a path; the rest still sign", async () => {
    const flaky = async (path: string) => {
      if (path.includes("bad")) throw new Error("storage down");
      return `https://cdn.example/${path}`;
    };
    expect(
      await withMediaUrls({ a: "ux/bad/fold.jpg", b: "ux/ok/fold.jpg" }, flaky),
    ).toEqual({
      a: "ux/bad/fold.jpg",
      b: "https://cdn.example/ux/ok/fold.jpg",
    });
  });

  test("leaves non-plain objects as they are", async () => {
    const at = new Date(T0);
    const out = await withMediaUrls({ at }, sign);
    expect(out.at).toBe(at);
  });
});
