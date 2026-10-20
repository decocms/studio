import { describe, expect, test } from "bun:test";
import { SandboxImageSchema } from "./types";

describe("SandboxImageSchema", () => {
  test("accepts the default and any template-suffix-shaped name", () => {
    for (const v of ["default", "flutter", "android-34", "a"]) {
      expect(SandboxImageSchema.parse(v)).toBe(v);
    }
  });

  test("rejects anything that cannot be a SandboxTemplate suffix", () => {
    for (const v of [
      "",
      "Flutter",
      "-flutter",
      "flutter_desktop",
      "a/b",
      "x".repeat(33),
    ]) {
      expect(SandboxImageSchema.safeParse(v).success).toBe(false);
    }
  });

  test("an unknown stored value falls back to default via catch", () => {
    expect(SandboxImageSchema.catch("default").parse(null)).toBe("default");
    expect(SandboxImageSchema.catch("default").parse("Bad Name")).toBe(
      "default",
    );
  });
});
