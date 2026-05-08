import { describe, expect, it } from "bun:test";
import { computeAppDomain, computeAppHash } from "./app-domain";

describe("computeAppHash", () => {
  it("is the first 8 hex chars of sha1(`${principal}-${app}`)", () => {
    // Golden value computed once with: echo -n "user-123-my-app" | shasum -a 1
    expect(computeAppHash("user-123", "my-app")).toBe("e54ab40b");
  });

  it("is stable across calls", () => {
    expect(computeAppHash("ws", "app")).toBe(computeAppHash("ws", "app"));
  });

  it("differs for different principals", () => {
    expect(computeAppHash("a", "x")).not.toBe(computeAppHash("b", "x"));
  });

  it("differs for different apps", () => {
    expect(computeAppHash("a", "x")).not.toBe(computeAppHash("a", "y"));
  });
});

describe("computeAppDomain", () => {
  it("returns localhost-<hash>.deco.host", () => {
    expect(computeAppDomain("user-123", "my-app")).toBe(
      "localhost-e54ab40b.deco.host",
    );
  });
});
