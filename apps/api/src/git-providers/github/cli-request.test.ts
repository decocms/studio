import { describe, expect, test } from "bun:test";
import { isLocalGithubCliRequest } from "./cli-request";

describe("local GitHub CLI request boundary", () => {
  test("accepts loopback sockets from the configured browser origin", () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(
        isLocalGithubCliRequest(
          address,
          "http://localhost:4000",
          "http://localhost:4000",
        ),
      ).toBe(true);
    }
    expect(
      isLocalGithubCliRequest("::1", "http://[::1]:4000", "http://[::1]:4000"),
    ).toBe(true);
  });

  test("accepts *.localhost subdomains matching the configured origin", () => {
    const url = "http://cms-required-prop-indicator.localhost";
    expect(isLocalGithubCliRequest("127.0.0.1", url, url)).toBe(true);
    expect(
      isLocalGithubCliRequest(
        "127.0.0.1",
        "http://my-branch.localhost:4000",
        "http://my-branch.localhost:4000",
      ),
    ).toBe(true);
  });

  test("rejects a lookalike host that only ends in .localhost mid-string", () => {
    // `localhost.evil.example` is remote; only a trailing `.localhost` is local.
    const url = "https://localhost.evil.example";
    expect(isLocalGithubCliRequest("127.0.0.1", url, url)).toBe(false);
    const spoof = "http://evil.example/.localhost";
    expect(isLocalGithubCliRequest("127.0.0.1", spoof, spoof)).toBe(false);
  });

  test("rejects missing or remote socket addresses even with a local origin", () => {
    for (const address of [undefined, "192.168.1.2", "203.0.113.1"]) {
      expect(
        isLocalGithubCliRequest(
          address,
          "http://localhost:4000",
          "http://localhost:4000",
        ),
      ).toBe(false);
    }
  });

  test("rejects cross-origin requests, missing origins and non-local deployments", () => {
    for (const origin of [
      undefined,
      "null",
      "https://evil.example",
      "http://localhost:4001",
      "http://localhost:4000.evil.example",
    ]) {
      expect(
        isLocalGithubCliRequest("127.0.0.1", origin, "http://localhost:4000"),
      ).toBe(false);
    }
    for (const url of [
      "https://studio.example",
      "https://localhost.evil.example",
      "file://localhost",
      "invalid",
    ]) {
      expect(isLocalGithubCliRequest("127.0.0.1", url, url)).toBe(false);
    }
  });
});
