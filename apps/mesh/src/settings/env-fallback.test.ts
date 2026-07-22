import { describe, expect, it } from "bun:test";
import { envWithFallback } from "./env-fallback";

describe("envWithFallback", () => {
  it("prefers the new name", () => {
    expect(
      envWithFallback({ STUDIO_X: "new", MESH_X: "old" }, "STUDIO_X", "MESH_X"),
    ).toBe("new");
  });

  it("falls back to the deprecated name", () => {
    expect(envWithFallback({ MESH_X: "old" }, "STUDIO_X", "MESH_X")).toBe(
      "old",
    );
  });

  it("treats empty strings as unset", () => {
    expect(
      envWithFallback({ STUDIO_X: "", MESH_X: "old" }, "STUDIO_X", "MESH_X"),
    ).toBe("old");
    expect(
      envWithFallback({ STUDIO_X: "", MESH_X: "" }, "STUDIO_X", "MESH_X"),
    ).toBeUndefined();
  });

  it("returns undefined when neither is set", () => {
    expect(envWithFallback({}, "STUDIO_X", "MESH_X")).toBeUndefined();
  });
});
