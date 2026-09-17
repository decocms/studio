import { describe, expect, it } from "bun:test";
import { pullRequestsFromLinks } from "./pr-link";

const us = (n: number) => ({ url: `https://github.com/acme/web-us/pull/${n}` });
const br = (n: number) => ({ url: `https://github.com/acme/web-br/pull/${n}` });
const preview = { url: "https://envs-acme--ab12cd.decocdn.com/collection/men" };

const numbers = (links: Array<{ url: string }>) =>
  pullRequestsFromLinks(links).map((r) => r.number);

describe("pullRequestsFromLinks", () => {
  it("finds the pull request among the issue's other links", () => {
    expect(numbers([preview, us(12)])).toEqual([12]);
    expect(pullRequestsFromLinks([us(12)])[0]?.repo.path).toBe("acme/web-us");
  });

  // A reciprocal-hreflang issue opened one in each storefront, and both are
  // the delivery — landing one alone is a broken signal, not half a feature.
  it("keeps one per repository when an issue spans several", () => {
    expect(numbers([us(381), br(2133)])).toEqual([2133, 381]);
  });

  // Another card carries the current attempt, a superseded one and a closed
  // one, all in the same repo. Numbers are monotonic per repository; link
  // ORDER is not, because deleting and re-adding a link reorders them.
  it("takes the highest number within one repository, whatever the order", () => {
    expect(numbers([us(386), us(337), us(338)])).toEqual([386]);
    expect(numbers([us(338), us(386), us(337)])).toEqual([386]);
  });

  it("does both at once", () => {
    expect(numbers([us(337), br(2133), us(386), preview])).toEqual([2133, 386]);
  });

  it("is empty when the issue names no pull request", () => {
    expect(pullRequestsFromLinks([])).toEqual([]);
    expect(pullRequestsFromLinks([preview])).toEqual([]);
    expect(pullRequestsFromLinks([{ url: "not a url" }])).toEqual([]);
  });
});
