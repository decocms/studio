import { describe, expect, test } from "bun:test";
import type { ContentClient, DescribeResult } from "@decocms/blocks/protocol";
import {
  authorFromChangedBy,
  authorFromChangeEntry,
  conflictAuthorSource,
  versionTag,
} from "./conflict-author";
import type { ContentBackend } from "./content-backend";

const params = { orgSlug: "acme", virtualMcpId: "p1", branch: "draft-1" };
const client = {} as ContentClient;
const protocol = (source: "github" | "local" | "sandbox"): ContentBackend => ({
  kind: "protocol",
  source,
  client,
  describe: {} as DescribeResult,
  cacheKeySuffix: ":4545",
});

describe("conflictAuthorSource", () => {
  test("a Fast Preview session and a hosted v8 draft read Studio's history", () => {
    expect(conflictAuthorSource({ kind: "legacy" }, true, params)).toEqual({
      kind: "history",
      key: "acme/p1/draft-1",
      params,
    });
    expect(conflictAuthorSource(protocol("github"), false, params)).toEqual({
      kind: "history",
      key: "acme/p1/draft-1",
      params,
    });
  });

  test("Localhost asks deco serve; a sandbox or a non-Fast-Preview v7 session has nothing", () => {
    expect(conflictAuthorSource(protocol("local"), false, params)).toEqual({
      kind: "local",
      key: "local:acme/p1/draft-1:4545",
      client,
    });
    expect(conflictAuthorSource(protocol("sandbox"), false, params)).toBeNull();
    expect(conflictAuthorSource({ kind: "legacy" }, false, params)).toBeNull();
    expect(conflictAuthorSource({ kind: "pending" }, true, params)).toBeNull();
  });
});

describe("authorFromChangedBy", () => {
  test("a member, the viewer, or only a time", () => {
    expect(
      authorFromChangedBy({
        name: "Ana Souza",
        avatarUrl: "https://img/ana.png",
        at: "2026-10-16T12:00:00.000Z",
      }),
    ).toEqual({
      kind: "person",
      name: "Ana Souza",
      avatarUrl: "https://img/ana.png",
      at: "2026-10-16T12:00:00.000Z",
      you: false,
    });
    expect(
      authorFromChangedBy({
        name: "Ana",
        at: "2026-10-16T12:00:00Z",
        you: true,
      }),
    ).toMatchObject({ kind: "person", you: true });
    expect(authorFromChangedBy({ at: "2026-10-16T12:00:00Z" })).toEqual({
      kind: "person",
      at: "2026-10-16T12:00:00Z",
      you: false,
    });
  });

  test("nothing, or no valid time, is unknown", () => {
    expect(authorFromChangedBy(undefined)).toBeNull();
    expect(authorFromChangedBy({ name: "Ana", at: "soon" })).toBeNull();
  });
});

describe("authorFromChangeEntry", () => {
  test("a deco serve that reports the file's modification time", () => {
    expect(
      authorFromChangeEntry({
        kind: "set",
        modifiedAt: "2026-10-16T12:00:00Z",
      }),
    ).toEqual({ kind: "local", at: "2026-10-16T12:00:00Z" });
  });

  test("one that doesn't (deco-content 1.1 without the field)", () => {
    expect(authorFromChangeEntry({ kind: "set" })).toBeNull();
    expect(authorFromChangeEntry(undefined)).toBeNull();
  });
});

describe("versionTag", () => {
  test("stable for one version, different for another", () => {
    expect(versionTag('{"a":1}')).toBe(versionTag('{"a":1}'));
    expect(versionTag('{"a":1}')).not.toBe(versionTag('{"a":2}'));
  });
});
