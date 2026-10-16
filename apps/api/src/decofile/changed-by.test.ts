import { describe, expect, test } from "bun:test";
import { appendCoAuthorTrailer } from "@decocms/sandbox/shared";
import type { RepoCommit } from "@/git-providers/insights";
import {
  authorOfCommit,
  coAuthorOf,
  draftChangeAuthors,
  latestChangeOf,
  type MemberLookup,
  toChangedBy,
} from "./changed-by";

function commit(over: Partial<RepoCommit> = {}): RepoCommit {
  return {
    sha: "abc",
    date: "2026-10-16T12:00:00Z",
    message: "Update home",
    author: { name: "decocms[bot]", email: null, login: "decocms[bot]" },
    ...over,
  };
}

describe("coAuthorOf", () => {
  test("reads the trailer the commit coalescer appends", () => {
    const message = appendCoAuthorTrailer("Update SharedHero", {
      userName: "Ana Souza",
      userEmail: "ana@acme.com",
    });
    expect(coAuthorOf(message)).toEqual({
      name: "Ana Souza",
      email: "ana@acme.com",
    });
  });

  test("a trailer without an email keeps the name", () => {
    expect(coAuthorOf("Update\n\nCo-authored-by: Ana Souza")).toEqual({
      name: "Ana Souza",
      email: null,
    });
  });

  test("the last trailer wins, in any case; none is null", () => {
    expect(
      coAuthorOf(
        "x\n\nCo-authored-by: A <a@x.com>\nco-authored-by: B <b@x.com>",
      ),
    ).toEqual({ name: "B", email: "b@x.com" });
    expect(coAuthorOf("Update home")).toBeNull();
  });
});

describe("authorOfCommit", () => {
  test("the Studio user from the trailer in the body, at the commit time", () => {
    expect(
      authorOfCommit(
        commit({ body: "Co-authored-by: Ana Souza <ana@acme.com>" }),
      ),
    ).toEqual({
      name: "Ana Souza",
      email: "ana@acme.com",
      userId: null,
      at: "2026-10-16T12:00:00.000Z",
    });
  });

  test("without a trailer, a person who pushed is the author", () => {
    expect(
      authorOfCommit(
        commit({
          author: { name: "Dev", email: "dev@acme.com", login: "dev" },
        }),
      ),
    ).toMatchObject({ name: "Dev", email: "dev@acme.com" });
  });

  test("without a trailer, a machine author leaves only the time", () => {
    expect(authorOfCommit(commit())).toEqual({
      name: null,
      email: null,
      userId: null,
      at: "2026-10-16T12:00:00.000Z",
    });
  });

  test("no valid time, no answer", () => {
    expect(authorOfCommit(commit({ date: "" }))).toBeNull();
  });
});

describe("latestChangeOf", () => {
  test("one history call for the file, one row", async () => {
    const calls: unknown[] = [];
    const author = await latestChangeOf(
      {
        listCommits: async (params) => {
          calls.push(params);
          return {
            items: [commit({ body: "Co-authored-by: Ana <ana@acme.com>" })],
            nextCursor: null,
          };
        },
      },
      "draft-1",
      ".deco/blocks/SharedHero.json",
      Date.parse("2026-10-16T12:00:00Z"),
    );
    expect(calls).toEqual([
      {
        ref: "draft-1",
        path: ".deco/blocks/SharedHero.json",
        since: "2026-07-18T12:00:00.000Z",
        limit: 1,
      },
    ]);
    expect(author?.name).toBe("Ana");
  });

  test("a file with no commit in the window has no author", async () => {
    expect(
      await latestChangeOf(
        { listCommits: async () => ({ items: [], nextCursor: null }) },
        "main",
        ".deco/blocks/x.json",
      ),
    ).toBeNull();
  });
});

describe("toChangedBy", () => {
  const ana = {
    userId: "u-ana",
    name: "Ana Souza",
    email: "Ana@Acme.com",
    image: "https://img/ana.png",
  };
  const lookup =
    (members = [ana], seen: unknown[] = []): MemberLookup =>
    async (query) => {
      seen.push(query);
      return members;
    };
  const at = "2026-10-16T12:00:00.000Z";

  test("a member by email shows their Studio name and avatar", async () => {
    const seen: unknown[] = [];
    expect(
      await toChangedBy(
        {
          SharedHero: {
            name: "ana (git)",
            email: "ana@acme.com",
            userId: null,
            at,
          },
        },
        lookup([ana], seen),
        { id: "u-bob", email: "bob@acme.com" },
      ),
    ).toEqual({
      SharedHero: {
        name: "Ana Souza",
        email: "Ana@Acme.com",
        avatarUrl: "https://img/ana.png",
        at,
      },
    });
    // One query, emails lowercased.
    expect(seen).toEqual([{ emails: ["ana@acme.com"], userIds: [] }]);
  });

  test("a member by user id (a v8 draft's record)", async () => {
    expect(
      await toChangedBy(
        { home: { name: null, email: null, userId: "u-ana", at } },
        lookup(),
        { id: "u-bob" },
      ),
    ).toEqual({
      home: {
        name: "Ana Souza",
        email: "Ana@Acme.com",
        avatarUrl: "https://img/ana.png",
        at,
      },
    });
  });

  test("the viewer is `you`, by id or by email", async () => {
    const byId = await toChangedBy(
      { home: { name: null, email: null, userId: "u-ana", at } },
      lookup(),
      { id: "u-ana" },
    );
    expect(byId.home?.you).toBe(true);
    const byEmail = await toChangedBy(
      { home: { name: "Ana", email: "ANA@acme.com", userId: null, at } },
      lookup([]),
      { id: "u-ana", email: "ana@acme.com" },
    );
    expect(byEmail.home).toEqual({ name: "Ana", at, you: true });
  });

  test("not a member: the git name, never the git email", async () => {
    expect(
      await toChangedBy(
        { home: { name: "Dev", email: "dev@else.com", userId: null, at } },
        lookup([]),
        { id: "u-bob" },
      ),
    ).toEqual({ home: { name: "Dev", at } });
  });

  test("nobody known: only the time, and no member query", async () => {
    const seen: unknown[] = [];
    expect(
      await toChangedBy(
        { home: { name: null, email: null, userId: null, at } },
        lookup([], seen),
        { id: "u-bob" },
      ),
    ).toEqual({ home: { at } });
    expect(seen).toEqual([]);
  });

  test("a failed member query falls back to the git name", async () => {
    expect(
      await toChangedBy(
        { home: { name: "Ana", email: "ana@acme.com", userId: null, at } },
        async () => {
          throw new Error("db down");
        },
        { id: "u-bob" },
      ),
    ).toEqual({ home: { name: "Ana", at } });
  });
});

describe("draftChangeAuthors", () => {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const at = "2026-10-16T12:00:00.000Z";

  test("a name the draft holds answers from its record, by spelling", () => {
    expect(
      draftChangeAuthors(
        {
          body: { set: { "pages-Home": {} }, delete: ["old"] },
          edits: { "pages-Home": { by: "u-ana", at } },
        },
        ["pages-home", "header", "old"],
        same,
      ),
    ).toEqual({
      authors: {
        "pages-home": { name: null, email: null, userId: "u-ana", at },
      },
      // "old" is the draft's (a deletion) but has no record: unknown, not main's.
      notInDraft: ["header"],
    });
  });

  test("no draft: every key falls back to main", () => {
    expect(draftChangeAuthors(null, ["a", "b"], same)).toEqual({
      authors: {},
      notInDraft: ["a", "b"],
    });
  });
});
