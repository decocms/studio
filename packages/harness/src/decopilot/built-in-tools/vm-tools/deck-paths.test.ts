import { describe, expect, test } from "bun:test";
import { matchDeckEntryPath, matchDeckToolPath } from "./deck-paths";

describe("matchDeckEntryPath", () => {
  test("matches volume-relative deck paths", () => {
    expect(matchDeckEntryPath("decks/q3-launch.html")).toEqual({
      path: "decks/q3-launch.html",
      name: "q3-launch",
    });
    expect(matchDeckEntryPath("decks/a.html")).toEqual({
      path: "decks/a.html",
      name: "a",
    });
    expect(matchDeckEntryPath("decks/My.Deck_2.HTML")).toEqual({
      path: "decks/My.Deck_2.HTML",
      name: "My.Deck_2",
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
    });
    expect(matchDeckToolPath("./org/acme/decks/launch.html", "acme")).toEqual({
      path: "decks/launch.html",
      name: "launch",
    });
    expect(
      matchDeckToolPath("/app/repo/org/acme/decks/launch.html", "acme"),
    ).toEqual({ path: "decks/launch.html", name: "launch" });
  });

  test("works with the reserved-slug fallback mount path", () => {
    expect(matchDeckToolPath("org/home/decks/launch.html", "home")).toEqual({
      path: "decks/launch.html",
      name: "launch",
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
