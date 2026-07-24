import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, test } from "bun:test";

describe("ThemeProvider OAuth redirect origin", () => {
  test("does not point MCP OAuth callbacks at the internal API URL", () => {
    const source = readFileSync(join(import.meta.dir, "theme-provider.tsx"), {
      encoding: "utf8",
    });

    expect(source).not.toContain("setOAuthRedirectOrigin");
  });
});
