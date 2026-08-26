import { describe, expect, it } from "bun:test";
import {
  secondaryRepoDirName,
  secondaryRepoDirNames,
} from "./secondary-repo-dirs.ts";

const r = (owner: string, name: string) => ({ owner, name });

describe("secondaryRepoDirNames", () => {
  it("uses the repo's own name, never the owner/name label", () => {
    expect(secondaryRepoDirNames([r("acme", "storefront")])).toEqual([
      "storefront",
    ]);
  });

  it("disambiguates a colliding name across owners", () => {
    expect(
      secondaryRepoDirNames([r("acme", "checkout"), r("other", "checkout")]),
    ).toEqual(["acme-checkout", "other-checkout"]);
  });

  it("leaves a non-colliding neighbour alone", () => {
    expect(
      secondaryRepoDirNames([
        r("acme", "checkout"),
        r("other", "checkout"),
        r("acme", "storefront"),
      ]),
    ).toEqual(["acme-checkout", "other-checkout", "storefront"]);
  });

  it("collides case-insensitively, as GitHub does", () => {
    expect(
      secondaryRepoDirNames([r("acme", "Checkout"), r("other", "checkout")]),
    ).toEqual(["acme-Checkout", "other-checkout"]);
  });

  // Matches the daemon's `repoNameRe`, which rejects separators and dot-opens.
  it("produces names the daemon accepts", () => {
    for (const name of secondaryRepoDirNames([
      r("acme", ".hidden"),
      r("acme", "weird name!"),
      r("acme", "..."),
    ])) {
      expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    }
  });

  it("has nothing to name for no repos", () => {
    expect(secondaryRepoDirNames([])).toEqual([]);
  });
});

// The whole point of the shared rule: TASK_ADD_REPO asks for one repo's name
// and provisioning asks for the whole list, and both must get the same answer.
describe("secondaryRepoDirName", () => {
  const all = [r("acme", "checkout"), r("other", "checkout")];

  it("agrees with the batch answer for the same set", () => {
    expect(secondaryRepoDirName(all, r("other", "checkout"))).toBe(
      "other-checkout",
    );
    expect(secondaryRepoDirName(all, r("ACME", "Checkout"))).toBe(
      "acme-checkout",
    );
  });

  it("returns nothing for a repo outside the set", () => {
    expect(secondaryRepoDirName(all, r("acme", "nope"))).toBeNull();
  });
});
