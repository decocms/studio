import { describe, expect, test } from "bun:test";
import { withSslmode } from "./index";

describe("withSslmode", () => {
  test("sets verify-full when SSL is enabled and sslmode is missing", () => {
    const url = withSslmode("postgresql://user:pass@host:5432/db", true);

    expect(new URL(url).searchParams.get("sslmode")).toBe("verify-full");
  });

  test("normalizes pg deprecated SSL modes to verify-full", () => {
    for (const mode of ["prefer", "require", "verify-ca"]) {
      const url = withSslmode(
        `postgresql://user:pass@host:5432/db?sslmode=${mode}`,
        true,
      );

      expect(new URL(url).searchParams.get("sslmode")).toBe("verify-full");
    }
  });

  test("normalizes pg deprecated SSL modes even when SSL is not forced by settings", () => {
    const url = withSslmode(
      "postgresql://user:pass@host:5432/db?sslmode=require",
      false,
    );

    expect(new URL(url).searchParams.get("sslmode")).toBe("verify-full");
  });

  test("leaves URLs without sslmode unchanged when SSL is disabled", () => {
    const input = "postgresql://user:pass@host:5432/db";

    expect(withSslmode(input, false)).toBe(input);
  });
});
