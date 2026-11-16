import { describe, expect, test } from "bun:test";
import type { ChangesListResult } from "@decocms/blocks/protocol";
import {
  adoptChangesList,
  changeSidesSignature,
  type ContentChanges,
} from "./content-changes";

const before: ContentChanges = {
  revision: "r1",
  base: { revision: "production-1", resolvedRef: "production-1" },
  changes: {},
};
const oldAnswer: ChangesListResult = {
  notModified: false,
  ...before,
};

describe("adopting an in-flight changes list", () => {
  test("a late full answer preserves a save adopted at the same listed revision", () => {
    const saved: ContentChanges = {
      ...before,
      edited: true,
      changes: { CMS: { kind: "set", version: "cms-2", baseVersion: "cms-1" } },
    };
    expect(adoptChangesList(before, oldAnswer, saved)).toBe(saved);
  });

  test("a late not-modified answer cannot replace a newer read or its production base", () => {
    const current: ContentChanges = {
      ...before,
      revision: "r2",
      base: { revision: "production-2", resolvedRef: "production-2" },
      changes: {
        home: { kind: "delete", version: null, baseVersion: "home-1" },
      },
    };
    expect(
      adoptChangesList(
        before,
        {
          notModified: true,
          revision: before.revision,
          base: before.base,
        },
        current,
      ),
    ).toBe(current);
  });

  test("a first read or fallback preserves content adopted while it was loading", () => {
    const current: ContentChanges = { ...before, revision: "r2" };
    expect(adoptChangesList(undefined, oldAnswer, current)).toBe(current);
  });

  test("an unchanged cache adopts a complete answer and preserves normal conditional reads", () => {
    const result = { ...oldAnswer, revision: "r2" };
    expect(adoptChangesList(before, result, before)?.revision).toBe("r2");
    expect(
      adoptChangesList(
        before,
        { notModified: true, revision: "r1", base: before.base },
        before,
      ),
    ).toEqual(before);
    expect(
      adoptChangesList(undefined, {
        notModified: true,
        revision: "r1",
        base: before.base,
      }),
    ).toBeNull();
  });
});

describe("change sides cache identity", () => {
  const changed: ContentChanges = {
    ...before,
    changes: {
      home: { kind: "set", version: "home-1", baseVersion: "base-home" },
    },
  };
  test("a local save gets new sides even while the list revision stays unchanged", () => {
    expect(changeSidesSignature(changed)).not.toBe(
      changeSidesSignature({
        ...changed,
        edited: true,
        changes: {
          home: { kind: "set", version: "home-2", baseVersion: "base-home" },
        },
      }),
    );
    expect(changeSidesSignature(changed)).not.toBe(
      changeSidesSignature({
        ...changed,
        edited: true,
        changes: {
          ...changed.changes,
          CMS: { kind: "set", version: "cms-1", baseVersion: null },
        },
      }),
    );
  });
  test("delete, production base and server revision transitions invalidate sides", () => {
    expect(changeSidesSignature(changed)).not.toBe(
      changeSidesSignature({
        ...changed,
        changes: {
          home: { kind: "delete", version: null, baseVersion: "base-home" },
        },
      }),
    );
    expect(changeSidesSignature(changed)).not.toBe(
      changeSidesSignature({
        ...changed,
        base: { ...changed.base, revision: "production-2" },
      }),
    );
    expect(changeSidesSignature(changed)).not.toBe(
      changeSidesSignature({ ...changed, revision: "r2" }),
    );
  });
  test("entry order and bookkeeping alone do not re-fetch unchanged sides", () => {
    const first: ContentChanges = {
      ...changed,
      changes: {
        ...changed.changes,
        CMS: { kind: "set", version: "cms-1", baseVersion: null },
      },
    };
    const second = {
      ...first,
      edited: true as const,
      changes: { CMS: first.changes.CMS!, home: first.changes.home! },
    };
    expect(changeSidesSignature(first)).toBe(changeSidesSignature(second));
  });
});
