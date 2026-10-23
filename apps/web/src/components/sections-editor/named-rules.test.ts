import { describe, expect, it } from "bun:test";
import {
  canRenameExperiment,
  experimentStatus,
  isInlineDateRule,
  isPlainRecord,
  namedRule,
  namedRuleKindOfBlock,
  namedRuleKindOfType,
  namedRuleNames,
  namedRuleOf,
  namedRuleSupport,
  readNamedRuleBlock,
  readNamedRuleValues,
  withNamedRuleEntry,
  withoutNamedRuleEntry,
  withRenamedNamedRuleEntry,
} from "./named-rules";

/**
 * The manifest `deco schema` writes for the built-ins (blocks with
 * split-traffic and calendar), as run on a copy of the demo site.
 */
const builtIn = (key: string, namespace = "deco") => ({
  $ref: `#/definitions/${btoa(key)}`,
  namespace,
});
const v8Meta = {
  blocksMajor: 8,
  manifest: {
    blocks: {
      matchers: {
        always: builtIn("always"),
        campaign: builtIn("campaign"),
        experiment: builtIn("experiment"),
      },
      content: {
        "cms-settings": builtIn("cms-settings"),
        "split-traffic": builtIn("split-traffic"),
        calendar: builtIn("calendar"),
      },
    },
  },
};

describe("namedRuleSupport", () => {
  it("is available when the schema lists the built-in type and matcher", () => {
    expect(namedRuleSupport(v8Meta, "experiments")).toBe("available");
    expect(namedRuleSupport(v8Meta, "campaigns")).toBe("available");
  });

  it("is missing on a schema from before the built-ins, a v7 schema or none", () => {
    // Before campaigns, v8 had a `date` rule with its own dates.
    const older = {
      blocksMajor: 8,
      manifest: {
        blocks: {
          matchers: { always: builtIn("always"), date: builtIn("date") },
          content: { "cms-settings": builtIn("cms-settings") },
        },
      },
    };
    expect(namedRuleSupport(older, "experiments")).toBe("missing");
    expect(namedRuleSupport(older, "campaigns")).toBe("missing");
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
    expect(namedRuleSupport(undefined, "campaigns")).toBe("missing");
    // Half of a kind is not the kind.
    const onlyMatcher = {
      manifest: { blocks: { matchers: { experiment: builtIn("experiment") } } },
    };
    expect(namedRuleSupport(onlyMatcher, "experiments")).toBe("missing");
  });

  it("is replaced when the site's block map declares one of the names", () => {
    const meta = structuredClone(v8Meta);
    meta.manifest.blocks.content["split-traffic"] = builtIn(
      "split-traffic",
      "site",
    );
    expect(namedRuleSupport(meta, "experiments")).toBe("replaced");
    expect(namedRuleSupport(meta, "campaigns")).toBe("available");
    meta.manifest.blocks.matchers.campaign = builtIn("campaign", "site");
    expect(namedRuleSupport(meta, "campaigns")).toBe("replaced");
  });
});

describe("readNamedRuleBlock", () => {
  it("is absent with no block, holding only the type for the first write", () => {
    const read = readNamedRuleBlock({}, "experiments");
    expect(read).toEqual({
      kind: "absent",
      block: { __resolveType: "split-traffic" },
      values: {},
      invalid: [],
    });
    expect(readNamedRuleBlock({ campaigns: null }, "campaigns").kind).toBe(
      "absent",
    );
    // Only the lowercase saved names count.
    expect(
      readNamedRuleBlock(
        { Experiments: { __resolveType: "experiments", a: 1 } },
        "experiments",
      ).kind,
    ).toBe("absent");
  });

  it("reads each test's share, listing what isn't a whole 0–100", () => {
    const read = readNamedRuleBlock(
      {
        experiments: {
          __resolveType: "split-traffic",
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
        campaigns: {
          __resolveType: "calendar",
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
      "campaigns",
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
        { experiments: { __resolveType: "site/loaders/flags.ts", a: 1 } },
        "experiments",
      ),
    ).toEqual({ kind: "conflict", resolveType: "site/loaders/flags.ts" });
    expect(readNamedRuleBlock({ campaigns: [1, 2] }, "campaigns")).toEqual({
      kind: "conflict",
      resolveType: "",
    });
  });

  it("doesn't read inherited names", () => {
    const read = readNamedRuleBlock(
      JSON.parse(
        '{"experiments":{"__resolveType":"split-traffic","__proto__":5}}',
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
        experiments: { __resolveType: "split-traffic", a: 20 },
        campaigns: { __resolveType: "something-else", b: {} },
      }),
    ).toEqual({ experiments: { a: 20 }, campaigns: {} });
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
    expect(
      namedRuleOf({ __resolveType: "campaign", name: "Black Friday" }),
    ).toEqual({ kind: "campaigns", name: "Black Friday" });
    expect(namedRuleOf({ __resolveType: "campaign", name: "" })).toEqual({
      kind: "campaigns",
      name: "",
    });
  });

  it("is null for any other rule", () => {
    expect(namedRuleOf({ __resolveType: "date", name: "x" })).toBeNull();
    // The v8 `date` rule is gone: naming a campaign there is no campaign's use.
    expect(namedRuleOf({ __resolveType: "date", campaign: "x" })).toBeNull();
    expect(
      namedRuleOf({ __resolveType: "campaign", campaign: "x" }),
    ).toBeNull();
    expect(
      namedRuleOf({ __resolveType: "date", start: "2026-11-27T00:00:00Z" }),
    ).toBeNull();
    expect(
      namedRuleOf({ __resolveType: "website/matchers/date.ts", campaign: "x" }),
    ).toBeNull();
    expect(namedRuleOf({ __resolveType: "experiment" })).toBeNull();
    expect(
      namedRuleOf({ __resolveType: "experiment", campaign: "x" }),
    ).toBeNull();
    expect(namedRuleOf({ __resolveType: "experiments" })).toBeNull();
    expect(namedRuleOf(null)).toBeNull();
    expect(namedRuleOf([])).toBeNull();
  });
});

describe("namedRule and inline dates", () => {
  it("builds the rule that names an entry", () => {
    expect(namedRule("experiments", "hero")).toEqual({
      __resolveType: "experiment",
      name: "hero",
    });
    expect(namedRule("campaigns", "Black Friday")).toEqual({
      __resolveType: "campaign",
      name: "Black Friday",
    });
  });

  it("tells a date rule with its own dates from one naming a campaign", () => {
    expect(
      isInlineDateRule({
        __resolveType: "date",
        start: "2026-11-27T00:00:00-03:00",
        end: "2026-12-01T00:00:00-03:00",
      }),
    ).toBe(true);
    expect(isInlineDateRule({ __resolveType: "date", end: "" })).toBe(true);
    expect(isInlineDateRule({ __resolveType: "campaign", name: "x" })).toBe(
      false,
    );
    expect(isInlineDateRule({ __resolveType: "date" })).toBe(false);
    // v7's date matcher is v7's: left alone.
    expect(
      isInlineDateRule({
        __resolveType: "website/matchers/date.ts",
        start: "2026-11-27T00:00:00-03:00",
      }),
    ).toBe(false);
  });
});

describe("editing the block", () => {
  const block = { __resolveType: "calendar", a: { start: "x" }, b: {} };

  it("adds or replaces a name, keeping the others", () => {
    expect(
      withNamedRuleEntry(
        { __resolveType: "split-traffic" },
        "experiments",
        "t",
        50,
      ),
    ).toEqual({ __resolveType: "split-traffic", t: 50 });
    expect(withNamedRuleEntry(block, "campaigns", "a", { end: "y" })).toEqual({
      __resolveType: "calendar",
      a: { end: "y" },
      b: {},
    });
  });

  it("removes a name, never the type", () => {
    expect(withoutNamedRuleEntry(block, "a")).toEqual({
      __resolveType: "calendar",
      b: {},
    });
    expect(withoutNamedRuleEntry(block, "__resolveType")).toBe(block);
  });

  it("renames in place, and not onto a taken name", () => {
    const renamed = withRenamedNamedRuleEntry(block, "a", "c");
    expect(renamed).toEqual({
      __resolveType: "calendar",
      c: { start: "x" },
      b: {},
    });
    expect(Object.keys(renamed)).toEqual(["__resolveType", "c", "b"]);
    expect(withRenamedNamedRuleEntry(block, "a", "b")).toBe(block);
    expect(withRenamedNamedRuleEntry(block, "missing", "c")).toBe(block);
    expect(withRenamedNamedRuleEntry(block, "a", "__resolveType")).toBe(block);
  });
});

describe("kind lookups", () => {
  it("finds a kind by its block's type or its block's name", () => {
    expect(namedRuleKindOfType("split-traffic")).toBe("experiments");
    expect(namedRuleKindOfType("calendar")).toBe("campaigns");
    expect(namedRuleKindOfType("experiments")).toBeNull();
    expect(namedRuleKindOfBlock("campaigns")).toBe("campaigns");
    expect(namedRuleKindOfBlock("calendar")).toBeNull();
  });

  it("lists every name the block holds, readable or not", () => {
    const decofile = {
      experiments: { __resolveType: "split-traffic", a: 50, bad: "x" },
      campaigns: { __resolveType: "site/loaders/x.ts" },
    };
    expect(namedRuleNames(readNamedRuleBlock(decofile, "experiments"))).toEqual(
      ["a", "bad"],
    );
    expect(namedRuleNames(readNamedRuleBlock(decofile, "campaigns"))).toEqual(
      [],
    );
    expect(namedRuleNames(readNamedRuleBlock({}, "campaigns"))).toEqual([]);
  });

  it("isPlainRecord takes objects only", () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord("x")).toBe(false);
  });
});
