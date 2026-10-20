import { describe, expect, it } from "bun:test";
import {
  canRenameExperiment,
  experimentStatus,
  namedRuleOf,
  namedRuleSupport,
  readNamedRuleBlock,
  readNamedRuleValues,
  withNamedRuleEntry,
  withoutNamedRuleEntry,
  withRenamedNamedRuleEntry,
} from "./named-rules";

/** The manifest `deco schema` writes for the built-ins (blocks with Experiments and Schedules). */
const builtIn = (key: string, namespace = "deco") => ({
  $ref: `#/definitions/${btoa(key)}`,
  namespace,
});
const v8Meta = {
  manifest: {
    blocks: {
      matchers: {
        always: builtIn("always"),
        date: builtIn("date"),
        experiment: builtIn("experiment"),
        schedule: builtIn("schedule"),
      },
      content: {
        "cms-settings": builtIn("cms-settings"),
        experiments: builtIn("experiments"),
        schedules: builtIn("schedules"),
      },
    },
  },
};

describe("namedRuleSupport", () => {
  it("is available when the schema lists the built-in type and matcher", () => {
    expect(namedRuleSupport(v8Meta, "experiments")).toBe("available");
    expect(namedRuleSupport(v8Meta, "schedules")).toBe("available");
  });

  it("is missing on a schema from before the built-ins, a v7 schema or none", () => {
    const older = {
      manifest: {
        blocks: {
          matchers: { always: builtIn("always"), date: builtIn("date") },
          content: { "cms-settings": builtIn("cms-settings") },
        },
      },
    };
    expect(namedRuleSupport(older, "experiments")).toBe("missing");
    expect(namedRuleSupport(older, "schedules")).toBe("missing");
    const v7 = {
      manifest: {
        blocks: {
          matchers: {
            "website/matchers/random.ts": { $ref: "#/definitions/random" },
          },
        },
      },
    };
    expect(namedRuleSupport(v7, "experiments")).toBe("missing");
    expect(namedRuleSupport(undefined, "schedules")).toBe("missing");
    // Half of a kind is not the kind.
    const onlyMatcher = {
      manifest: { blocks: { matchers: { schedule: builtIn("schedule") } } },
    };
    expect(namedRuleSupport(onlyMatcher, "schedules")).toBe("missing");
  });

  it("is replaced when the site's block map declares one of the names", () => {
    const meta = structuredClone(v8Meta);
    meta.manifest.blocks.content.experiments = builtIn("experiments", "site");
    expect(namedRuleSupport(meta, "experiments")).toBe("replaced");
    expect(namedRuleSupport(meta, "schedules")).toBe("available");
  });
});

describe("readNamedRuleBlock", () => {
  it("is absent with no block, holding only the type for the first write", () => {
    const read = readNamedRuleBlock({}, "experiments");
    expect(read).toEqual({
      kind: "absent",
      block: { __resolveType: "experiments" },
      values: {},
      invalid: [],
    });
    expect(readNamedRuleBlock({ Schedules: null }, "schedules").kind).toBe(
      "absent",
    );
  });

  it("reads each test's share, listing what isn't a whole 0–100", () => {
    const read = readNamedRuleBlock(
      {
        Experiments: {
          __resolveType: "experiments",
          "hero-headline": 50,
          off: 0,
          shipped: 100,
          half: 10.5,
          tooMuch: 120,
          text: "50",
        },
      },
      "experiments",
    );
    expect(read.kind).toBe("saved");
    if (read.kind !== "saved") return;
    expect(read.values).toEqual({ "hero-headline": 50, off: 0, shipped: 100 });
    expect(read.invalid).toEqual(["half", "tooMuch", "text"]);
  });

  it("reads each campaign's window; a cleared bound is no bound", () => {
    const read = readNamedRuleBlock(
      {
        Schedules: {
          __resolveType: "schedules",
          "Black Friday": {
            start: "2026-11-27T00:00:00-03:00",
            end: "2026-12-02T00:00:00-03:00",
          },
          Forever: {},
          Open: { start: "2026-01-01T00:00:00Z", end: null },
          Cleared: { start: "", end: "2026-02-01T00:00:00Z" },
          Broken: { start: 3 },
          NotAWindow: "2026-01-01",
        },
      },
      "schedules",
    );
    expect(read.kind).toBe("saved");
    if (read.kind !== "saved") return;
    expect(read.values).toEqual({
      "Black Friday": {
        start: "2026-11-27T00:00:00-03:00",
        end: "2026-12-02T00:00:00-03:00",
      },
      Forever: {},
      Open: { start: "2026-01-01T00:00:00Z" },
      Cleared: { end: "2026-02-01T00:00:00Z" },
    });
    expect(read.invalid).toEqual(["Broken", "NotAWindow"]);
  });

  it("is a conflict for a block of that name with another type, never a write", () => {
    expect(
      readNamedRuleBlock(
        { Experiments: { __resolveType: "site/loaders/flags.ts", a: 1 } },
        "experiments",
      ),
    ).toEqual({ kind: "conflict", resolveType: "site/loaders/flags.ts" });
    expect(readNamedRuleBlock({ Schedules: [1, 2] }, "schedules")).toEqual({
      kind: "conflict",
      resolveType: "",
    });
  });

  it("doesn't read inherited names", () => {
    const read = readNamedRuleBlock(
      JSON.parse(
        '{"Experiments":{"__resolveType":"experiments","__proto__":5}}',
      ),
      "experiments",
    );
    expect(read.kind).toBe("saved");
    if (read.kind !== "saved") return;
    expect(Object.keys(read.values)).toEqual(["__proto__"]);
    expect(read.values.toString).toBeUndefined();
  });
});

describe("readNamedRuleValues", () => {
  it("reads both kinds, and nothing from a conflicting block", () => {
    expect(
      readNamedRuleValues({
        Experiments: { __resolveType: "experiments", a: 20 },
        Schedules: { __resolveType: "something-else", b: {} },
      }),
    ).toEqual({ experiments: { a: 20 }, schedules: {} });
  });
});

describe("experiment status and renames", () => {
  it("derives the status from the share", () => {
    expect(experimentStatus(0)).toBe("off");
    expect(experimentStatus(1)).toBe("running");
    expect(experimentStatus(99)).toBe("running");
    expect(experimentStatus(100)).toBe("everyone");
  });

  it("locks a running test's name", () => {
    expect(canRenameExperiment(50)).toBe(false);
    expect(canRenameExperiment(0)).toBe(true);
    expect(canRenameExperiment(100)).toBe(true);
    expect(canRenameExperiment(undefined)).toBe(true);
  });
});

describe("namedRuleOf", () => {
  it("reads the kind and name of a rule", () => {
    expect(namedRuleOf({ __resolveType: "experiment", name: "hero" })).toEqual({
      kind: "experiments",
      name: "hero",
    });
    expect(namedRuleOf({ __resolveType: "schedule", name: "" })).toEqual({
      kind: "schedules",
      name: "",
    });
  });

  it("is null for any other rule", () => {
    expect(namedRuleOf({ __resolveType: "date", name: "x" })).toBeNull();
    expect(namedRuleOf({ __resolveType: "experiment" })).toBeNull();
    expect(namedRuleOf({ __resolveType: "Experiments" })).toBeNull();
    expect(namedRuleOf(null)).toBeNull();
    expect(namedRuleOf([])).toBeNull();
  });
});

describe("editing the block", () => {
  const block = { __resolveType: "schedules", a: { start: "x" }, b: {} };

  it("adds or replaces a name, keeping the others", () => {
    expect(
      withNamedRuleEntry(
        { __resolveType: "experiments" },
        "experiments",
        "t",
        50,
      ),
    ).toEqual({ __resolveType: "experiments", t: 50 });
    expect(withNamedRuleEntry(block, "schedules", "a", { end: "y" })).toEqual({
      __resolveType: "schedules",
      a: { end: "y" },
      b: {},
    });
  });

  it("removes a name, never the type", () => {
    expect(withoutNamedRuleEntry(block, "a")).toEqual({
      __resolveType: "schedules",
      b: {},
    });
    expect(withoutNamedRuleEntry(block, "__resolveType")).toBe(block);
  });

  it("renames in place, and not onto a taken name", () => {
    const renamed = withRenamedNamedRuleEntry(block, "a", "c");
    expect(renamed).toEqual({
      __resolveType: "schedules",
      c: { start: "x" },
      b: {},
    });
    expect(Object.keys(renamed)).toEqual(["__resolveType", "c", "b"]);
    expect(withRenamedNamedRuleEntry(block, "a", "b")).toBe(block);
    expect(withRenamedNamedRuleEntry(block, "missing", "c")).toBe(block);
    expect(withRenamedNamedRuleEntry(block, "a", "__resolveType")).toBe(block);
  });
});
