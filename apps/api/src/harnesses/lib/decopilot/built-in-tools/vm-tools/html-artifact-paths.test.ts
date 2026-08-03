import { describe, expect, test } from "bun:test";
import {
  type HtmlArtifactChangeEntry,
  matchHtmlArtifactEntry,
  matchHtmlArtifactToolPath,
  matchOwnHtmlArtifact,
} from "./html-artifact-paths";

describe("matchHtmlArtifactEntry", () => {
  test("matches volume-relative deck paths", () => {
    expect(matchHtmlArtifactEntry("decks/q3-launch.html")).toEqual({
      path: "decks/q3-launch.html",
      name: "q3-launch",
      kind: "deck",
    });
    expect(matchHtmlArtifactEntry("decks/a.html")).toEqual({
      path: "decks/a.html",
      name: "a",
      kind: "deck",
    });
    expect(matchHtmlArtifactEntry("decks/My.Deck_2.HTML")).toEqual({
      path: "decks/My.Deck_2.HTML",
      name: "My.Deck_2",
      kind: "deck",
    });
  });

  test("matches standalone pages with kind page", () => {
    expect(matchHtmlArtifactEntry("pages/landing.html")).toEqual({
      path: "pages/landing.html",
      name: "landing",
      kind: "page",
    });
  });

  test("rejects non-deck paths", () => {
    expect(matchHtmlArtifactEntry("decks/launch.md")).toBeNull();
    expect(matchHtmlArtifactEntry("decks/nested/launch.html")).toBeNull();
    expect(matchHtmlArtifactEntry("notes/launch.html")).toBeNull();
    expect(matchHtmlArtifactEntry("launch.html")).toBeNull();
    expect(matchHtmlArtifactEntry("decks/.hidden.html")).toBeNull();
    expect(matchHtmlArtifactEntry("")).toBeNull();
  });
});

describe("matchHtmlArtifactToolPath", () => {
  test("matches mount-relative tool paths", () => {
    expect(
      matchHtmlArtifactToolPath("org/acme/decks/launch.html", "acme"),
    ).toEqual({
      path: "decks/launch.html",
      name: "launch",
      kind: "deck",
    });
    expect(
      matchHtmlArtifactToolPath("./org/acme/decks/launch.html", "acme"),
    ).toEqual({
      path: "decks/launch.html",
      name: "launch",
      kind: "deck",
    });
    expect(
      matchHtmlArtifactToolPath("/app/repo/org/acme/decks/launch.html", "acme"),
    ).toEqual({ path: "decks/launch.html", name: "launch", kind: "deck" });
    expect(
      matchHtmlArtifactToolPath("org/acme/pages/landing.html", "acme"),
    ).toEqual({
      path: "pages/landing.html",
      name: "landing",
      kind: "page",
    });
  });

  test("works with the reserved-slug fallback mount path", () => {
    expect(
      matchHtmlArtifactToolPath("org/home/decks/launch.html", "home"),
    ).toEqual({
      path: "decks/launch.html",
      name: "launch",
      kind: "deck",
    });
  });

  test("rejects other mounts, volumes, and traversal-ish paths", () => {
    expect(
      matchHtmlArtifactToolPath("org/other/decks/launch.html", "acme"),
    ).toBeNull();
    expect(
      matchHtmlArtifactToolPath("org/upload/decks/launch.html", "acme"),
    ).toBeNull();
    expect(matchHtmlArtifactToolPath("decks/launch.html", "acme")).toBeNull();
    expect(
      matchHtmlArtifactToolPath("xorg/acme/decks/launch.html", "acme"),
    ).toBeNull();
    expect(
      matchHtmlArtifactToolPath("org/acme/decks/launch.html", ""),
    ).toBeNull();
    expect(
      matchHtmlArtifactToolPath("org/acme/decks/nested/launch.html", "acme"),
    ).toBeNull();
  });
});

describe("matchOwnHtmlArtifact", () => {
  const entry = (
    over: Partial<HtmlArtifactChangeEntry> = {},
  ): HtmlArtifactChangeEntry => ({
    kind: "file",
    deletedAt: null,
    updatedBy: "user-a",
    threadId: "thread-1",
    path: "decks/launch.html",
    ...over,
  });
  const scope = { threadId: "thread-1", ownerId: "user-a" };

  test("emits decks stamped with the current thread", () => {
    expect(matchOwnHtmlArtifact(entry(), scope)).toEqual({
      path: "decks/launch.html",
      name: "launch",
      kind: "deck",
    });
  });

  test("drops another chat's deck (same user, different thread)", () => {
    // The reported same-user-two-chats leak: a tool-written deck from the
    // user's other chat carries that chat's thread stamp, not this run's.
    expect(
      matchOwnHtmlArtifact(entry({ threadId: "thread-2" }), scope),
    ).toBeNull();
  });

  test("drops another member's deck (foreign thread)", () => {
    expect(
      matchOwnHtmlArtifact(
        entry({ threadId: "thread-2", updatedBy: "user-b" }),
        scope,
      ),
    ).toBeNull();
  });

  test("falls back to same-user scope for unstamped (bash/slides) writes", () => {
    expect(matchOwnHtmlArtifact(entry({ threadId: null }), scope)).toEqual({
      path: "decks/launch.html",
      name: "launch",
      kind: "deck",
    });
  });

  test("drops another member's unstamped write (cross-member, no thread)", () => {
    expect(
      matchOwnHtmlArtifact(
        entry({ threadId: null, updatedBy: "user-b" }),
        scope,
      ),
    ).toBeNull();
  });

  test("ignores tombstones, dirs, and non-deck paths", () => {
    expect(
      matchOwnHtmlArtifact(entry({ deletedAt: "2026-06-15" }), scope),
    ).toBeNull();
    expect(matchOwnHtmlArtifact(entry({ kind: "dir" }), scope)).toBeNull();
    expect(
      matchOwnHtmlArtifact(entry({ path: "notes/launch.html" }), scope),
    ).toBeNull();
  });

  test("with no current thread, only same-user unstamped writes pass", () => {
    const noThread = { threadId: null, ownerId: "user-a" };
    expect(
      matchOwnHtmlArtifact(entry({ threadId: null }), noThread),
    ).not.toBeNull();
    // A stamped deck can't be confirmed as this run's when we have no thread id.
    expect(
      matchOwnHtmlArtifact(entry({ threadId: "thread-1" }), noThread),
    ).toBeNull();
  });
});
