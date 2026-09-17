import { describe, expect, it } from "bun:test";
import { pullRequestsFromLinks } from "./pr-link";

/**
 * `openPrForIssue` itself needs a StudioContext and a provider, so it belongs
 * to e2e. What IS pure — and what the decision actually turns on — is the
 * "exactly one, or nothing" rule it applies to the issue's links.
 */
describe("what a continuation can be resolved from", () => {
  const us = (n: number) => ({
    url: `https://github.com/acme/web-us/pull/${n}`,
  });
  const br = (n: number) => ({
    url: `https://github.com/acme/web-br/pull/${n}`,
  });

  it("is one pull request when the issue names one repository", () => {
    expect(pullRequestsFromLinks([us(374), us(300)])).toHaveLength(1);
  });

  // `pr` names ONE pull request and its lead tells the run it is already
  // standing on that branch. It can only stand on one, so an issue spanning
  // two repositories resolves to nothing and the run starts fresh — wasteful,
  // never wrong.
  it("is ambiguous when the issue spans two, so the caller must bail", () => {
    expect(pullRequestsFromLinks([us(381), br(2133)])).toHaveLength(2);
  });

  it("is nothing when the issue names no pull request", () => {
    expect(
      pullRequestsFromLinks([{ url: "https://envs-x.decocdn.com/" }]),
    ).toHaveLength(0);
  });
});
