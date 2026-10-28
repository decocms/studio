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
    expect(monitorScope("b", two)).toBe("b");
  });

  it("reads the only project of an org with one", () => {
    expect(monitorScope(null, [project("a")])).toBe("a");
  });

  it("is every project across an org with several", () => {
    expect(monitorScope(null, two)).toBeNull();
  });
});
