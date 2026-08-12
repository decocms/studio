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

  test("resolves a synced-repo skill against the org volume mount", () => {
    expect(resolveSkillPath("repo/my-skills/slides")).toBe(
      "org/my-skills/slides/SKILL.md",
    );
    expect(resolveSkillPath("repo/my-skills/nested/dir")).toBe(
      "org/my-skills/nested/dir/SKILL.md",
    );
  });

  test("rejects a repo id without a skill dir", () => {
    // `repo/<volume>` alone names the volume, not a skill.
    expect(resolveSkillPath("repo/my-skills")).toBeNull();
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
