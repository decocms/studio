import { describe, expect, it } from "bun:test";
import {
  groupShowMoreIdentity,
  shouldDeferGroupProbe,
} from "./group-show-more-identity";

describe("groupShowMoreIdentity", () => {
  it("includes org, kind, key, and filter fields", () => {
    expect(
      groupShowMoreIdentity("org-1", "agent", "vm-a", {
        type: "manual",
        member: "mine",
        currentUserId: "user-1",
      }),
    ).toBe("org-1|agent|vm-a|manual|mine|user-1");
  });
});

describe("shouldDeferGroupProbe", () => {
  it("waits for currentUserId when member is mine", () => {
    expect(
      shouldDeferGroupProbe({
        type: "all",
        member: "mine",
        currentUserId: null,
      }),
    ).toBe(true);
    expect(
      shouldDeferGroupProbe({
        type: "all",
        member: "mine",
        currentUserId: "user-1",
      }),
    ).toBe(false);
  });

  it("does not defer for all members", () => {
    expect(
      shouldDeferGroupProbe({
        type: "all",
        member: "all",
        currentUserId: null,
      }),
    ).toBe(false);
  });
});
