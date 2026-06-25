import { describe, expect, it } from "bun:test";
import {
  classifyKind,
  expandHex,
  findBrandLogo,
  groupColorFamilies,
  isColorValue,
  parseBrandTokens,
  updateBrandToken,
} from "./brand";

const TOKENS = `/* Acme brand */
:root {
  --brand-primary: #0a84ff;
  --brand-accent: oklch(0.7 0.15 30);
  --brand-font-display: "Inter", sans-serif;
  --brand-radius: 12px;
}
`;

describe("parseBrandTokens", () => {
  it("parses --brand-* props in source order with classification", () => {
    const tokens = parseBrandTokens(TOKENS);
    expect(tokens.map((t) => t.name)).toEqual([
      "--brand-primary",
      "--brand-accent",
      "--brand-font-display",
      "--brand-radius",
    ]);
    expect(tokens[0]).toMatchObject({ value: "#0a84ff", isColor: true });
    expect(tokens[1]).toMatchObject({ isColor: true, isFont: false });
    expect(tokens[2]).toMatchObject({
      value: '"Inter", sans-serif',
      isFont: true,
      isColor: false,
    });
    expect(tokens[3]).toMatchObject({ isColor: false, isFont: false });
  });

  it("ignores non --brand-* declarations and keeps last value on dupes", () => {
    const t = parseBrandTokens(
      ":root{ --other: red; --brand-primary: #111; --brand-primary: #222; }",
    );
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ name: "--brand-primary", value: "#222" });
  });

  it("returns [] for empty input", () => {
    expect(parseBrandTokens("")).toEqual([]);
  });
});

describe("isColorValue", () => {
  it("recognizes hex and functional colors", () => {
    for (const v of [
      "#fff",
      "#ff0000",
      "#ff0000aa",
      "rgb(1,2,3)",
      "oklch(0.5 0.1 20)",
    ]) {
      expect(isColorValue(v)).toBe(true);
    }
  });
  it("rejects fonts, sizes, keywords", () => {
    for (const v of ['"Inter", sans-serif', "12px", "bold"]) {
      expect(isColorValue(v)).toBe(false);
    }
  });
});

describe("expandHex", () => {
  it("expands 3-digit hex, passes through others", () => {
    expect(expandHex("#abc")).toBe("#aabbcc");
    expect(expandHex("#aabbcc")).toBe("#aabbcc");
    expect(expandHex('"Inter"')).toBe('"Inter"');
  });
});

describe("updateBrandToken", () => {
  it("replaces a value in place, preserving the rest", () => {
    const next = updateBrandToken(TOKENS, "--brand-primary", "#123456");
    expect(next).toContain("--brand-primary: #123456;");
    expect(next).toContain("--brand-accent: oklch(0.7 0.15 30);");
    expect(next).toContain("/* Acme brand */");
  });

  it("handles values containing $ safely", () => {
    const next = updateBrandToken(TOKENS, "--brand-font-display", '"$pecial"');
    expect(next).toContain('--brand-font-display: "$pecial";');
  });

  it("inserts a missing token into :root", () => {
    const next = updateBrandToken(TOKENS, "--brand-secondary", "#eee");
    expect(next).toContain("--brand-secondary: #eee;");
    expect(
      parseBrandTokens(next).some((t) => t.name === "--brand-secondary"),
    ).toBe(true);
  });

  it("creates a :root block when the file has none", () => {
    const next = updateBrandToken("", "--brand-primary", "#000");
    expect(next).toContain(":root {");
    expect(next).toContain("--brand-primary: #000;");
  });
});

describe("classifyKind", () => {
  it("buckets tokens by name and color-ness", () => {
    expect(classifyKind("--brand-primary-500", true, false)).toBe("color");
    expect(classifyKind("--brand-font-display", false, true)).toBe("font");
    expect(classifyKind("--brand-text-xl", false, false)).toBe("type");
    expect(classifyKind("--brand-fw-bold", false, false)).toBe("type");
    expect(classifyKind("--brand-space-4", false, false)).toBe("space");
    expect(classifyKind("--brand-radius-lg", false, false)).toBe("radius");
    expect(classifyKind("--brand-shadow-glow", false, false)).toBe("shadow");
    expect(classifyKind("--brand-duration-fast", false, false)).toBe("motion");
    expect(classifyKind("--brand-ease", false, false)).toBe("motion");
    expect(classifyKind("--brand-z-modal", false, false)).toBe("other");
  });

  it("parseBrandTokens attaches kind", () => {
    const t = parseBrandTokens(
      ":root{ --brand-primary: #0a84ff; --brand-space-4: 16px; }",
    );
    expect(t.find((x) => x.name === "--brand-primary")?.kind).toBe("color");
    expect(t.find((x) => x.name === "--brand-space-4")?.kind).toBe("space");
  });
});

describe("groupColorFamilies", () => {
  const css = `:root{
    --brand-fg: #fff;
    --brand-primary: #0a84ff;
    --brand-primary-50: #eef6ff;
    --brand-primary-100: #d9ecff;
    --brand-primary-200: #b5d9ff;
    --brand-primary-300: #84c0ff;
    --brand-primary-500: #0a84ff;
    --brand-success: #16a34a;
    --brand-space-4: 16px;
  }`;
  it("groups colors by family, flags ramps, orders by DS, ignores non-colors", () => {
    const fams = groupColorFamilies(parseBrandTokens(css));
    // space-4 excluded; families ordered primary, success, fg
    expect(fams.map((f) => f.family)).toEqual(["primary", "success", "fg"]);
    const primary = fams.find((f) => f.family === "primary")!;
    expect(primary.isRamp).toBe(true); // 5 stepped + the base alias
    expect(primary.tokens).toHaveLength(6);
    expect(fams.find((f) => f.family === "success")!.isRamp).toBe(false);
  });
});

describe("findBrandLogo", () => {
  const file = (path: string) => ({ path, kind: "file" as const });
  it("prefers logo.<ext>, then any image", () => {
    expect(
      findBrandLogo([
        file("brands/acme/notes.txt"),
        file("brands/acme/logo.svg"),
      ]),
    ).toBe("brands/acme/logo.svg");
    expect(findBrandLogo([file("brands/acme/hero.png")])).toBe(
      "brands/acme/hero.png",
    );
  });
  it("returns null with no image and ignores dirs", () => {
    expect(
      findBrandLogo([
        file("brands/acme/brand.md"),
        { path: "brands/acme/logo", kind: "dir" },
      ]),
    ).toBeNull();
  });
});
