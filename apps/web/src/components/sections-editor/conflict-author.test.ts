import { describe, expect, test } from "bun:test";
import {
  authorFromChangedBy,
  conflictAuthorSource,
  versionTag,
} from "./conflict-author";

const params = { orgSlug: "acme", virtualMcpId: "p1", branch: "draft-1" };
describe("conflictAuthorSource", () => {
  test("a Fast Preview session reads Studio's history; a sandbox session has nothing", () => {
    expect(conflictAuthorSource(true, params)).toEqual({
      kind: "history",
      key: "acme/p1/draft-1",
      params,
    });
    expect(conflictAuthorSource(false, params)).toBeNull();
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

describe("versionTag", () => {
  test("stable for one version, different for another", () => {
    expect(versionTag('{"a":1}')).toBe(versionTag('{"a":1}'));
    expect(versionTag('{"a":1}')).not.toBe(versionTag('{"a":2}'));
  });
});
