import { describe, expect, it } from "bun:test";
import {
  AVATAR_DIR,
  avatarExtension,
  avatarPath,
  isValidUserVolume,
  USER_FS_API_PREFIX,
  userFsReadUrl,
} from "./user-fs";

describe("avatarExtension", () => {
  it("maps the allowed raster types", () => {
    expect(avatarExtension("image/png")).toBe("png");
    expect(avatarExtension("image/jpeg")).toBe("jpg");
    expect(avatarExtension("image/gif")).toBe("gif");
    expect(avatarExtension("image/webp")).toBe("webp");
  });

  it("tolerates parameters and casing on the header", () => {
    expect(avatarExtension("image/PNG")).toBe("png");
    expect(avatarExtension("image/jpeg; charset=binary")).toBe("jpg");
    expect(avatarExtension(" image/webp ")).toBe("webp");
  });

  it("refuses SVG — it can carry script and is served to anyone", () => {
    expect(avatarExtension("image/svg+xml")).toBeNull();
  });

  it("refuses non-images and missing types", () => {
    expect(avatarExtension("text/html")).toBeNull();
    expect(avatarExtension("application/octet-stream")).toBeNull();
    expect(avatarExtension(undefined)).toBeNull();
    expect(avatarExtension("")).toBeNull();
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
