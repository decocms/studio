import { describe, expect, it } from "bun:test";
import { ORGANIZATION_MEMBER_LIST } from "./member-list";

describe("ORGANIZATION_MEMBER_LIST", () => {
  it("rejects an unbounded, negative, or non-integer limit/offset", () => {
    // Regression: limit/offset used to be a plain z.number() with no bounds.
    expect(() =>
      ORGANIZATION_MEMBER_LIST.inputSchema.parse({ limit: 1_000_000 }),
    ).toThrow();
    expect(() =>
      ORGANIZATION_MEMBER_LIST.inputSchema.parse({ limit: -1 }),
    ).toThrow();
    expect(() =>
      ORGANIZATION_MEMBER_LIST.inputSchema.parse({ offset: -1 }),
    ).toThrow();
    expect(() =>
      ORGANIZATION_MEMBER_LIST.inputSchema.parse({ limit: 1.5 }),
    ).toThrow();
    expect(
      ORGANIZATION_MEMBER_LIST.inputSchema.parse({ limit: 1000, offset: 0 }),
    ).toEqual({ limit: 1000, offset: 0 });
  });
});
