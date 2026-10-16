import { describe, expect, test } from "bun:test";
import type { ContentClient, DescribeResult } from "@decocms/blocks/protocol";
import {
  authorFromChangedBy,
  authorFromChangeEntry,
  conflictAuthorSource,
  draftEditFor,
  resolveMemberAuthor,
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
  test("a Fast Preview session reads Studio's history; a hosted v8 draft its own edits", () => {
    expect(conflictAuthorSource({ kind: "legacy" }, true, params)).toEqual({
      kind: "history",
      key: "acme/p1/draft-1",
      params,
    });
    expect(conflictAuthorSource(protocol("github"), false, params)).toEqual({
      kind: "draft",
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

describe("draftEditFor", () => {
  const at = "2026-10-16T12:00:00Z";
  const edits = {
    "pages-Home Page": { userId: "u-ana", at },
    header: null,
  };

  test("a name the draft holds, by any spelling; null when not recorded", () => {
    expect(draftEditFor(edits, "pages-Home Page")).toEqual({
      userId: "u-ana",
      at,
    });
    // Another spelling of the same name (as the protocol's file names).
    expect(draftEditFor(edits, "pages-Home%20Page")).toEqual({
      userId: "u-ana",
      at,
    });
    expect(draftEditFor(edits, "header")).toBeNull();
  });

  test("a name the draft doesn't hold is main's (undefined)", () => {
    expect(draftEditFor(edits, "footer")).toBeUndefined();
  });
});

describe("resolveMemberAuthor", () => {
  const at = "2026-10-16T12:00:00Z";
  const members = [
    {
      userId: "u-ana",
      user: { name: "Ana Souza", image: "https://img/ana.png" },
    },
  ];

  test("the draft's user id becomes the member's name and avatar", () => {
    expect(
      resolveMemberAuthor(
        { kind: "member", userId: "u-ana", at },
        members,
        "u-bob",
      ),
    ).toEqual({
      kind: "person",
      name: "Ana Souza",
      avatarUrl: "https://img/ana.png",
      at,
      you: false,
    });
  });

  test("the viewer's own id is `you`", () => {
    expect(
      resolveMemberAuthor(
        { kind: "member", userId: "u-ana", at },
        members,
        "u-ana",
      ).kind === "person" &&
        resolveMemberAuthor(
          { kind: "member", userId: "u-ana", at },
          members,
          "u-ana",
        ),
    ).toMatchObject({ you: true });
  });

  test("an id that isn't a member shows only the time", () => {
    expect(
      resolveMemberAuthor(
        { kind: "member", userId: "u-gone", at },
        members,
        "u-bob",
      ),
    ).toEqual({ kind: "person", at, you: false });
  });

  test("an author from git or Localhost passes through", () => {
    const local = { kind: "local" as const, at };
    expect(resolveMemberAuthor(local, members, null)).toBe(local);
  });
});
