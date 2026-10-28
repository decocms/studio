import { describe, expect, it } from "bun:test";
import { monitorScope } from "./project-filter";

const project = (id: string) => ({
  id,
  title: id,
  icon: null,
  site: id,
  analyticsSite: id,
});

describe("monitorScope", () => {
  const two = [project("a"), project("b")];

  it("keeps the route's project", () => {
    expect(monitorScope("b", two, "a")).toBe("b");
  });

  it("reads the only project of an org with one", () => {
    expect(monitorScope(null, [project("a")], undefined)).toBe("a");
  });

  it("follows the filter's pick when it names a project here", () => {
    expect(monitorScope(null, two, "b")).toBe("b");
  });

  it("is every project when nothing, or something stale, is picked", () => {
    expect(monitorScope(null, two, undefined)).toBeNull();
    expect(monitorScope(null, two, "gone")).toBeNull();
  });
});
