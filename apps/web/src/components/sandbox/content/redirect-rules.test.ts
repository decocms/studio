import { describe, expect, it } from "bun:test";
import {
  appendRedirectRule,
  extractRedirectRules,
  getRedirectRulePayload,
  REDIRECTS_BLOCK,
  redirectRuleBlocks,
  redirectRuleOf,
  redirectsBlockName,
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
    const blocks = { [REDIRECTS_BLOCK]: block };
    expect(redirectRuleOf("Redirects#1", blocks)).toEqual({
      block: "Redirects",
      index: 1,
    });
    expect(redirectRuleOf("redirects-x", blocks)).toBeNull();
    expect(redirectRuleOf("Redirects#-1", blocks)).toBeNull();
    expect(redirectRuleOf("Redirects#", blocks)).toBeNull();
    expect(redirectRuleOf("Redirects#1.5", blocks)).toBeNull();
  });

  it("names a rule by the block that holds it, whatever that block is called", () => {
    // The SDK routes the first redirects block by name, called anything.
    const blocks = {
      "site-redirects": block,
      "promo#2": { __resolveType: "website/loaders/redirect.ts" },
    };
    expect(redirectsBlockName(blocks)).toBe("site-redirects");
    expect(extractRedirectRules(blocks).map((e) => e.key)).toEqual([
      "site-redirects#0",
      "site-redirects#1",
    ]);
    expect(redirectRuleOf("site-redirects#1", blocks)).toEqual({
      block: "site-redirects",
      index: 1,
    });
    // A per-rule block whose name has a "#" is a block, not a rule.
    expect(redirectRuleOf("promo#2", blocks)).toBeNull();
    // Nothing to hold them yet: a new rule creates `Redirects`.
    expect(redirectsBlockName({ "promo#2": blocks["promo#2"] })).toBe(
      REDIRECTS_BLOCK,
    );
    expect(redirectsBlockName({ b: block, a: block })).toBe("a");
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
