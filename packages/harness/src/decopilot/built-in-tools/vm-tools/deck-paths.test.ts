import { describe, expect, test } from "bun:test";
import {
  type DeckChangeEntry,
  matchDeckEntryPath,
  matchDeckToolPath,
  matchOwnDeckEntry,
} from "./deck-paths";

describe("matchDeckEntryPath", () => {
  test("matches volume-relative deck paths", () => {
    expect(matchDeckEntryPath("decks/q3-launch.html")).toEqual({
      path: "decks/q3-launch.html",
      name: "q3-launch",
      kind: "deck",
    });
    expect(matchDeckEntryPath("decks/a.html")).toEqual({
      path: "decks/a.html",
      name: "a",
      kind: "deck",
    });
    expect(matchDeckEntryPath("decks/My.Deck_2.HTML")).toEqual({
      path: "decks/My.Deck_2.HTML",
      name: "My.Deck_2",
      kind: "deck",
    });
  });

  test("matches standalone pages with kind page", () => {
    expect(matchDeckEntryPath("pages/landing.html")).toEqual({
      path: "pages/landing.html",
      name: "landing",
      kind: "page",
    });
  });

  test("rejects non-deck paths", () => {
    expect(matchDeckEntryPath("decks/launch.md")).toBeNull();
    expect(matchDeckEntryPath("decks/nested/launch.html")).toBeNull();
    expect(matchDeckEntryPath("notes/launch.html")).toBeNull();
    expect(matchDeckEntryPath("launch.html")).toBeNull();
    expect(matchDeckEntryPath("decks/.hidden.html")).toBeNull();
    expect(matchDeckEntryPath("")).toBeNull();
  });
});

describe("matchDeckToolPath", () => {
  test("matches mount-relative tool paths", () => {
    expect(matchDeckToolPath("org/acme/decks/launch.html", "acme")).toEqual({
      path: "decks/launch.html",
      name: "launch",
      kind: "deck",
    });
    expect(matchDeckToolPath("./org/acme/decks/launch.html", "acme")).toEqual({
      path: "decks/launch.html",
      name: "launch",
      kind: "deck",
    });
    expect(
      matchDeckToolPath("/app/repo/org/acme/decks/launch.html", "acme"),
    ).toEqual({ path: "decks/launch.html", name: "launch", kind: "deck" });
    expect(matchDeckToolPath("org/acme/pages/landing.html", "acme")).toEqual({
      path: "pages/landing.html",
      name: "landing",
      kind: "page",
    });
  });

  test("works with the reserved-slug fallback mount path", () => {
    expect(matchDeckToolPath("org/home/decks/launch.html", "home")).toEqual({
      path: "decks/launch.html",
      name: "launch",
      kind: "deck",
    });
  });

  test("rejects other mounts, volumes, and traversal-ish paths", () => {
    expect(matchDeckToolPath("org/other/decks/launch.html", "acme")).toBeNull();
    expect(
      matchDeckToolPath("org/upload/decks/launch.html", "acme"),
    ).toBeNull();
    expect(matchDeckToolPath("decks/launch.html", "acme")).toBeNull();
    expect(matchDeckToolPath("xorg/acme/decks/launch.html", "acme")).toBeNull();
    expect(matchDeckToolPath("org/acme/decks/launch.html", "")).toBeNull();
    expect(
      matchDeckToolPath("org/acme/decks/nested/launch.html", "acme"),
    ).toBeNull();
  });
});

describe("matchOwnDeckEntry", () => {
  const entry = (over: Partial<DeckChangeEntry> = {}): DeckChangeEntry => ({
    kind: "file",
    deletedAt: null,
    updatedBy: "user-a",
    threadId: "thread-1",
    path: "decks/launch.html",
    ...over,
  });
  const scope = { threadId: "thread-1", ownerId: "user-a" };

  test("emits decks stamped with the current thread", () => {
    expect(matchOwnDeckEntry(entry(), scope)).toEqual({
      path: "decks/launch.html",
      name: "launch",
      kind: "deck",
    });
  });

  test("drops another chat's deck (same user, different thread)", () => {
    // The reported same-user-two-chats leak: a tool-written deck from the
    // user's other chat carries that chat's thread stamp, not this run's.
    expect(
      matchOwnDeckEntry(entry({ threadId: "thread-2" }), scope),
    ).toBeNull();
  });

  test("drops another member's deck (foreign thread)", () => {
    expect(
      matchOwnDeckEntry(
        entry({ threadId: "thread-2", updatedBy: "user-b" }),
        scope,
      ),
    ).toBeNull();
  });

  test("falls back to same-user scope for unstamped (bash/slides) writes", () => {
    expect(matchOwnDeckEntry(entry({ threadId: null }), scope)).toEqual({
      path: "decks/launch.html",
      name: "launch",
      kind: "deck",
    });
  });

  test("drops another member's unstamped write (cross-member, no thread)", () => {
    expect(
      matchOwnDeckEntry(entry({ threadId: null, updatedBy: "user-b" }), scope),
    ).toBeNull();
  });

  test("ignores tombstones, dirs, and non-deck paths", () => {
    expect(
      matchOwnDeckEntry(entry({ deletedAt: "2026-06-15" }), scope),
    ).toBeNull();
    expect(matchOwnDeckEntry(entry({ kind: "dir" }), scope)).toBeNull();
    expect(
      matchOwnDeckEntry(entry({ path: "notes/launch.html" }), scope),
    ).toBeNull();
  });

  test("with no current thread, only same-user unstamped writes pass", () => {
    const noThread = { threadId: null, ownerId: "user-a" };
    expect(
      matchOwnDeckEntry(entry({ threadId: null }), noThread),
    ).not.toBeNull();
    // A stamped deck can't be confirmed as this run's when we have no thread id.
    expect(
      matchOwnDeckEntry(entry({ threadId: "thread-1" }), noThread),
    ).toBeNull();
  });
});
