import { describe, expect, test } from "bun:test";
import { accountGrantCovers } from "./credentials";
import type { GitProviderAccountRecord } from "@/storage/git-provider-accounts";

const account = (
  overrides: Partial<GitProviderAccountRecord>,
): GitProviderAccountRecord =>
  ({
    authKind: "github_app",
    installationRepositoryIds: [10, 20],
    ...overrides,
  }) as GitProviderAccountRecord;

describe("accountGrantCovers", () => {
  test("a partial grant covers only the ids it lists", () => {
    expect(accountGrantCovers(account({}), { externalId: "20" })).toBe(true);
    expect(accountGrantCovers(account({}), { externalId: "30" })).toBe(false);
  });

  test("a partial grant cannot cover a repository with no recorded id", () => {
    expect(accountGrantCovers(account({}), { externalId: null })).toBe(false);
  });

  test("a whole-installation grant covers everything", () => {
    const whole = account({ installationRepositoryIds: null });
    expect(accountGrantCovers(whole, { externalId: null })).toBe(true);
  });

  test("non-App accounts have no grant to check", () => {
    const oauth = account({ authKind: "oauth" });
    expect(accountGrantCovers(oauth, { externalId: "30" })).toBe(true);
  });
});
