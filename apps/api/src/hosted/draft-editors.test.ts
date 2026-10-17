import { describe, expect, test } from "bun:test";
import {
  decodeDraftEditors,
  encodeDraftEditors,
  MAX_EDITORS_BYTES,
  stampDraftEditors,
} from "./draft-editors";

const T0 = 1_760_000_000;

describe("encodeDraftEditors / decodeDraftEditors", () => {
  test("round-trips names and ids with any characters, as ASCII", () => {
    const editors = {
      "pages-Home Page": { userId: "u_ana", at: T0 },
      "a,b;c%d/é": { userId: "u,b;o%b", at: T0 + 5 },
      __proto__x: { userId: "u3", at: T0 + 9 },
    };
    const value = encodeDraftEditors(editors);
    expect(value).toMatch(/^[\x20-\x7e]*$/);
    expect(decodeDraftEditors(value)).toEqual(editors);
  });

  test("is compact: name, user id and base-36 seconds, oldest first", () => {
    expect(
      encodeDraftEditors({
        b: { userId: "u2", at: T0 + 1 },
        a: { userId: "u1", at: T0 },
      }),
    ).toBe(`a,u1,${T0.toString(36)};b,u2,${(T0 + 1).toString(36)}`);
  });

  test("drops the oldest entries until it fits the 2 KB metadata limit", () => {
    const editors = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [
        `pages-section-${i}`,
        { userId: `user-${i}`, at: T0 + i },
      ]),
    );
    const value = encodeDraftEditors(editors);
    expect(value.length).toBeLessThanOrEqual(MAX_EDITORS_BYTES);
    const kept = decodeDraftEditors(value);
    // The newest are kept; the oldest went first.
    expect(kept["pages-section-199"]).toEqual({
      userId: "user-199",
      at: T0 + 199,
    });
    expect(kept["pages-section-0"]).toBeUndefined();
    const keptAt = Object.values(kept).map((e) => e.at);
    expect(Math.min(...keptAt)).toBeGreaterThan(T0);
    expect(encodeDraftEditors(editors, 10)).toBe("");
  });

  test("nothing, or a malformed value, is no editors; a bad entry is skipped alone", () => {
    expect(decodeDraftEditors(undefined)).toEqual({});
    expect(decodeDraftEditors("")).toEqual({});
    expect(
      decodeDraftEditors(`x,u1;%E0%A4%A,u2,1;ok,u3,${T0.toString(36)};a,b,c,d`),
    ).toEqual({ ok: { userId: "u3", at: T0 } });
  });
});

describe("stampDraftEditors", () => {
  test("a changed name is stamped; an untouched one keeps its stamp", () => {
    expect(
      stampDraftEditors(
        { home: { userId: "ana", at: T0 }, header: { userId: "ana", at: T0 } },
        { set: { home: { a: 1 }, header: { b: 1 } }, delete: [] },
        { set: { home: { a: 2 }, header: { b: 1 } }, delete: [] },
        "bob",
        T0 + 60,
      ),
    ).toEqual({
      home: { userId: "bob", at: T0 + 60 },
      header: { userId: "ana", at: T0 },
    });
  });

  test("a new deletion is stamped; a name no longer in the draft is dropped", () => {
    expect(
      stampDraftEditors(
        { home: { userId: "ana", at: T0 } },
        { set: { home: {} }, delete: [] },
        { set: {}, delete: ["footer"] },
        "bob",
        T0 + 60,
      ),
    ).toEqual({ footer: { userId: "bob", at: T0 + 60 } });
  });

  test("a change by nobody known drops the old stamp instead of keeping a wrong one", () => {
    expect(
      stampDraftEditors(
        { home: { userId: "ana", at: T0 } },
        { set: { home: { a: 1 } }, delete: [] },
        { set: { home: { a: 2 } }, delete: [] },
        null,
        T0 + 60,
      ),
    ).toEqual({});
  });
});
