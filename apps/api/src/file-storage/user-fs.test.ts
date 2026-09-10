import { describe, expect, it } from "bun:test";
import {
  AVATAR_DIR,
  avatarPath,
  isValidUserVolume,
  sniffAvatarType,
  USER_FS_API_PREFIX,
  userFsReadUrl,
} from "./user-fs";

const png = (extra: number[] = []) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extra]);

describe("sniffAvatarType", () => {
  it("recognizes the four raster formats from their leading bytes", () => {
    expect(sniffAvatarType(png())).toEqual({ mime: "image/png", ext: "png" });
    expect(sniffAvatarType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      mime: "image/jpeg",
      ext: "jpg",
    });
    expect(
      sniffAvatarType(new Uint8Array([...Buffer.from("GIF89a"), 0x01])),
    ).toEqual({ mime: "image/gif", ext: "gif" });
    expect(
      sniffAvatarType(
        new Uint8Array([...Buffer.from("RIFF????WEBPVP8 ", "binary")]),
      ),
    ).toEqual({ mime: "image/webp", ext: "webp" });
  });

  it("accepts the older GIF87a signature", () => {
    expect(
      sniffAvatarType(new Uint8Array([...Buffer.from("GIF87a"), 0x01])),
    ).toEqual({ mime: "image/gif", ext: "gif" });
  });

  it("refuses SVG — it can carry script and is served to anyone", () => {
    expect(
      sniffAvatarType(new Uint8Array(Buffer.from("<svg></svg>"))),
    ).toBeNull();
  });

  it("refuses HTML dressed up as an image, whatever the caller claims", () => {
    expect(
      sniffAvatarType(new Uint8Array(Buffer.from("<!doctype html><script>"))),
    ).toBeNull();
  });

  it("refuses a RIFF container that is not WebP", () => {
    expect(
      sniffAvatarType(
        new Uint8Array(Buffer.from("RIFF????WAVEfmt ", "binary")),
      ),
    ).toBeNull();
  });

  it("refuses empty and truncated input without reading past the end", () => {
    expect(sniffAvatarType(new Uint8Array())).toBeNull();
    expect(sniffAvatarType(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(
      sniffAvatarType(new Uint8Array([0x47, 0x49, 0x46, 0x38])),
    ).toBeNull();
  });
});

describe("avatarPath", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);

  it("lands under the published directory", () => {
    expect(avatarPath(bytes, "png").startsWith(`${AVATAR_DIR}/`)).toBe(true);
  });

  it("is content-addressed, so the same picture reuses the key", () => {
    expect(avatarPath(bytes, "png")).toBe(
      avatarPath(new Uint8Array([1, 2, 3, 4]), "png"),
    );
  });

  it("separates different bytes", () => {
    expect(avatarPath(bytes, "png")).not.toBe(
      avatarPath(new Uint8Array([9, 9, 9]), "png"),
    );
  });

  it("carries the extension so the read route infers the content-type", () => {
    expect(avatarPath(bytes, "webp").endsWith(".webp")).toBe(true);
  });
});

describe("isValidUserVolume", () => {
  it("accepts the id shapes Better Auth issues", () => {
    expect(isValidUserVolume("nWq4h1ZfKk3vGqCq0J6xY8pLtRbA2sDe")).toBe(true);
    expect(isValidUserVolume("01JB4Z9V-2QK_TEST.x")).toBe(true);
  });

  it("rejects ids that would escape or collapse the volume segment", () => {
    expect(isValidUserVolume("")).toBe(false);
    expect(isValidUserVolume(".")).toBe(false);
    expect(isValidUserVolume("..")).toBe(false);
    expect(isValidUserVolume("a/b")).toBe(false);
    expect(isValidUserVolume("a b")).toBe(false);
  });
});

describe("userFsReadUrl", () => {
  it("builds an org-free, same-origin URL with the path encoded", () => {
    expect(
      userFsReadUrl("https://studio.test", "user_1", "avatars/a b.png"),
    ).toBe(
      `https://studio.test${USER_FS_API_PREFIX}/fs/user_1/read?path=avatars%2Fa+b.png`,
    );
  });

  it("does not double a trailing slash on the base URL", () => {
    expect(
      userFsReadUrl("https://studio.test/", "user_1", "avatars/a.png"),
    ).toBe(
      `https://studio.test${USER_FS_API_PREFIX}/fs/user_1/read?path=avatars%2Fa.png`,
    );
  });
});
