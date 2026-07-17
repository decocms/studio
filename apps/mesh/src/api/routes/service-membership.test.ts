import { afterEach, describe, expect, it } from "bun:test";
import { isServiceMembershipToken, safeEqual } from "./service-membership";

describe("safeEqual", () => {
  it("matches equal strings and rejects different ones (incl. different lengths — no throw)", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false); // length guard, timingSafeEqual would throw otherwise
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("isServiceMembershipToken", () => {
  const prev = process.env.SERVICE_MEMBERSHIP_TOKEN;
  afterEach(() => {
    if (prev === undefined) delete process.env.SERVICE_MEMBERSHIP_TOKEN;
    else process.env.SERVICE_MEMBERSHIP_TOKEN = prev;
  });

  it("is off when the env var is unset", () => {
    delete process.env.SERVICE_MEMBERSHIP_TOKEN;
    expect(isServiceMembershipToken("anything")).toBe(false);
  });

  it("accepts the configured token, rejects others", () => {
    process.env.SERVICE_MEMBERSHIP_TOKEN = "svc-secret";
    expect(isServiceMembershipToken("svc-secret")).toBe(true);
    expect(isServiceMembershipToken("wrong")).toBe(false);
    expect(isServiceMembershipToken("")).toBe(false);
  });
});
