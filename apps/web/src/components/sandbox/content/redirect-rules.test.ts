import { describe, expect, it } from "bun:test";
import {
  appendRedirectRule,
  extractRedirectRules,
  getRedirectRulePayload,
  REDIRECTS_BLOCK,
  redirectRuleBlocks,
  redirectRuleIndex,
  removeRedirectRule,
  setRedirectRule,
} from "./redirect-data";

const nested = { redirect: { from: "/a", to: "/b", type: "permanent" } };
const flat = { from: "/old", to: "/new", status: 308, keep: 1 };
const block = { __resolveType: "redirects", redirects: [nested, flat] };

describe("the redirects block (hosted v8)", () => {
  it("lists its rules as entries keyed by position, each in the shape it was stored in", () => {
    const entries = extractRedirectRules({ [REDIRECTS_BLOCK]: block });
    expect(entries.map((e) => e.key)).toEqual(["Redirects#0", "Redirects#1"]);
    expect(entries[0]).toMatchObject({
      from: "/a",
      to: "/b",
      type: "permanent",
    });
    expect(entries[1]).toMatchObject({ from: "/old", flat: true, status: 308 });
    expect(redirectRuleIndex("Redirects#1")).toBe(1);
    expect(redirectRuleIndex("redirects-x")).toBeNull();
    expect(redirectRuleIndex("Redirects#-1")).toBeNull();
  });

  it("is created on the first rule", () => {
    expect(
      appendRedirectRule(undefined, {
        from: "/x",
        to: "/y",
        type: "temporary",
        discardQueryParameters: false,
      }),
    ).toEqual({
      __resolveType: "redirects",
      redirects: [{ redirect: { from: "/x", to: "/y", type: "temporary" } }],
    });
  });

  it("edits one rule in place, keeping the fields the editor doesn't know", () => {
    const payload = getRedirectRulePayload(block, 1);
    const next = setRedirectRule(block, 1, { ...payload, to: "/newer" });
    expect(next.redirects).toEqual([
      nested,
      { from: "/old", to: "/newer", permanent: false, status: 308, keep: 1 },
    ]);
  });

  it("removes one rule", () => {
    expect(removeRedirectRule(block, 0).redirects).toEqual([flat]);
  });

  it("gives lists per-rule blocks", () => {
    expect(redirectRuleBlocks(REDIRECTS_BLOCK, block)).toEqual([
      [
        "Redirects#0",
        { ...nested, __resolveType: "website/loaders/redirect.ts" },
      ],
      ["Redirects#1", { ...flat, __resolveType: "redirect" }],
    ]);
  });
});
