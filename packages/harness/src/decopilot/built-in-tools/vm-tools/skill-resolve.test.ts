import { describe, expect, test } from "bun:test";
import { resolveSkillPath } from "./skill-resolve";

describe("resolveSkillPath", () => {
  test("resolves a public-set skill", () => {
    expect(resolveSkillPath("core/slides")).toBe(
      "org/public/core/slides/SKILL.md",
    );
  });

  test("resolves a nested public id", () => {
    expect(resolveSkillPath("storefront/seo/audit")).toBe(
      "org/public/storefront/seo/audit/SKILL.md",
    );
  });

  test("resolves a home skill against the fixed org/home path", () => {
    expect(resolveSkillPath("home/skills/onboarding")).toBe(
      "org/home/skills/onboarding/SKILL.md",
    );
    expect(resolveSkillPath("home/foo")).toBe("org/home/foo/SKILL.md");
  });

  test("rejects traversal, absolute, and malformed ids", () => {
    expect(resolveSkillPath("../etc/passwd")).toBeNull();
    expect(resolveSkillPath("core/../../secret")).toBeNull();
    expect(resolveSkillPath("/core/slides")).toBeNull();
    expect(resolveSkillPath("core/")).toBeNull();
    expect(resolveSkillPath("core")).toBeNull();
    expect(resolveSkillPath("")).toBeNull();
    expect(resolveSkillPath("core/sli des")).toBeNull();
  });
});
