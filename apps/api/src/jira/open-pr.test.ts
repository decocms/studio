import { describe, expect, it } from "bun:test";
import { pullRequestsFromLinks } from "./pr-link";

/**
 * `openPrForIssue` itself needs a StudioContext and a provider, so it belongs
 * to e2e. What IS pure — and what the decision actually turns on — is which
 * candidates the issue's links yield: the first open one is the run's own
 * branch, the rest are named for it to check out.
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

  // The sandbox pins to ONE branch, so the first is the run's own and the
  // second becomes `others` — named in the prompt with its branch.
  it("is one per repository when the issue spans two", () => {
    expect(pullRequestsFromLinks([us(381), br(2133)])).toHaveLength(2);
  });

  it("is nothing when the issue names no pull request", () => {
    expect(
      pullRequestsFromLinks([{ url: "https://envs-x.decocdn.com/" }]),
    ).toHaveLength(0);
  });
});
