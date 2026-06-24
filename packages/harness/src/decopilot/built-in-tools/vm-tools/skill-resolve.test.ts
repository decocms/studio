import { describe, expect, test } from "bun:test";
import { resolveSkillPath } from "./skill-resolve";

describe("resolveSkillPath", () => {
  test("resolves a public-set skill", () => {
    expect(resolveSkillPath("core/slides", "acme")).toBe(
      "org/public/core/slides/SKILL.md",
    );
  });

  test("resolves a nested public id", () => {
    expect(resolveSkillPath("storefront/seo/audit", "acme")).toBe(
      "org/public/storefront/seo/audit/SKILL.md",
    );
  });

  test("resolves a home skill against the org slug", () => {
    expect(resolveSkillPath("home/skills/onboarding", "acme")).toBe(
      "org/acme/skills/onboarding/SKILL.md",
    );
    expect(resolveSkillPath("home/foo", "acme")).toBe("org/acme/foo/SKILL.md");
  });

  test("falls back to literal `home` for reserved/unsafe/empty slugs", () => {
    expect(resolveSkillPath("home/foo", "public")).toBe(
      "org/home/foo/SKILL.md",
    );
    expect(resolveSkillPath("home/foo", "")).toBe("org/home/foo/SKILL.md");
    expect(resolveSkillPath("home/foo", null)).toBe("org/home/foo/SKILL.md");
  });

  test("rejects traversal, absolute, and malformed ids", () => {
    expect(resolveSkillPath("../etc/passwd", "acme")).toBeNull();
    expect(resolveSkillPath("core/../../secret", "acme")).toBeNull();
    expect(resolveSkillPath("/core/slides", "acme")).toBeNull();
    expect(resolveSkillPath("core/", "acme")).toBeNull();
    expect(resolveSkillPath("core", "acme")).toBeNull();
    expect(resolveSkillPath("", "acme")).toBeNull();
    expect(resolveSkillPath("core/sli des", "acme")).toBeNull();
  });
});
