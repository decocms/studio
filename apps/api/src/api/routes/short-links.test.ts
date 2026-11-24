import { describe, expect, test } from "bun:test";
import { labelSlug, parseShortLinkId } from "./short-links";

describe("labelSlug", () => {
  test("strips accents and punctuation", () => {
    expect(labelSlug("Relatórios · Q1")).toBe("relatorios-q1");
    expect(labelSlug("Perfil")).toBe("perfil");
  });

  test("empty and symbol-only names give no label", () => {
    expect(labelSlug("")).toBe("");
    expect(labelSlug("···")).toBe("");
  });

  test("caps long names", () => {
    expect(labelSlug("a".repeat(100))).toHaveLength(40);
  });
});

describe("parseShortLinkId", () => {
  test("reads the id after the label", () => {
    expect(parseShortLinkId("/s/people/perfil-Hq3vT8nLw1")).toBe("Hq3vT8nLw1");
    expect(parseShortLinkId("/s/Hq3vT8nLw1")).toBe("Hq3vT8nLw1");
  });

  test("ignores the label, so a stale one still resolves", () => {
    expect(parseShortLinkId("/s/old-name-Hq3vT8nLw1")).toBe("Hq3vT8nLw1");
  });

  test("rejects malformed ids", () => {
    expect(parseShortLinkId("/s/")).toBeNull();
    expect(parseShortLinkId("/s/perfil-short")).toBeNull();
    expect(parseShortLinkId("/s/perfil-Hq3vT8nLw1x")).toBeNull();
    expect(parseShortLinkId("/s/perfil-Hq3vT8nL_1")).toBeNull();
  });
});
