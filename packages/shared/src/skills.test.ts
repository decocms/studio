import { describe, expect, it } from "bun:test";
import {
  bundleIdOfRef,
  bundleRef,
  expandSkillRefs,
  invalidSkillRefs,
  skillsLoadLine,
} from "./skills";

const CATALOG = [
  {
    id: "core/qa-screenshot",
    bundles: ["pr-qa"],
    disableModelInvocation: false,
  },
  {
    id: "storefront/ecommerce-qa",
    bundles: ["pr-qa", "go-live"],
    disableModelInvocation: false,
  },
  { id: "core/jira-release", bundles: ["pr-qa"], disableModelInvocation: true },
  { id: "core/slides", disableModelInvocation: false },
];

describe("skill references", () => {
  it("round-trips a bundle reference", () => {
    expect(bundleIdOfRef(bundleRef("pr-qa"))).toBe("pr-qa");
    expect(bundleIdOfRef("core/slides")).toBeNull();
  });

  it("expands bundles to loadable members, keeping plain ids and order", () => {
    expect(
      expandSkillRefs(
        ["core/slides", bundleRef("pr-qa"), "core/qa-screenshot"],
        CATALOG,
      ),
    ).toEqual(["core/slides", "core/qa-screenshot", "storefront/ecommerce-qa"]);
  });

  it("expands an empty bundle to nothing", () => {
    expect(expandSkillRefs([bundleRef("writing")], CATALOG)).toEqual([]);
  });

  it("rejects unknown ids, unknown bundles and manual-only skills", () => {
    expect(
      invalidSkillRefs(["core/slides", bundleRef("pr-qa")], CATALOG),
    ).toBeNull();
    expect(invalidSkillRefs(["core/nope"], CATALOG)).toContain("core/nope");
    expect(invalidSkillRefs(["bundle:nope"], CATALOG)).toContain("bundle:nope");
    expect(invalidSkillRefs(["core/jira-release"], CATALOG)).toContain(
      "Manual-only",
    );
  });

  it("writes no load line for no skills", () => {
    expect(skillsLoadLine([])).toBeUndefined();
    expect(skillsLoadLine(["a", "b"])).toContain("a, b");
  });
});
