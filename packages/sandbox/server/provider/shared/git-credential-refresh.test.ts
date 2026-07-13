import { describe, expect, test } from "bun:test";
import {
  cloneUrlHasCredentials,
  gitCredentialRefreshPatch,
} from "./git-credential-refresh";
import type { EnsureOptions } from "../types";

const repo = (cloneUrl: string): EnsureOptions => ({
  repo: { cloneUrl, userName: "u", userEmail: "e" },
});

describe("cloneUrlHasCredentials", () => {
  test("true when userinfo is present", () => {
    expect(
      cloneUrlHasCredentials(
        "https://x-access-token:ghs_abc@github.com/o/r.git",
      ),
    ).toBe(true);
  });

  test("false for anonymous clone URL", () => {
    expect(cloneUrlHasCredentials("https://github.com/o/r.git")).toBe(false);
  });

  test("false for a non-URL string", () => {
    expect(cloneUrlHasCredentials("git@github.com:o/r.git")).toBe(false);
  });
});

describe("gitCredentialRefreshPatch", () => {
  test("forwards only the credentialed cloneUrl", () => {
    expect(
      gitCredentialRefreshPatch(
        repo("https://x-access-token:ghs_NEW@github.com/o/r.git"),
      ),
    ).toEqual({
      git: {
        repository: {
          cloneUrl: "https://x-access-token:ghs_NEW@github.com/o/r.git",
        },
      },
    });
  });

  test("null for a public (anonymous) clone — nothing to rotate", () => {
    expect(gitCredentialRefreshPatch(repo("https://github.com/o/r.git"))).toBe(
      null,
    );
  });

  test("null when no repo is set (tool-only / smoke sandbox)", () => {
    expect(gitCredentialRefreshPatch({})).toBe(null);
  });
});
