import { describe, expect, it } from "bun:test";
import {
  currentNamedRule,
  inlineDateWindow,
  isoToLocalInput,
  localInputToIso,
  missingNamedRuleWithin,
  namedRuleBlockFieldKinds,
  namedRuleBlockFieldValue,
  namedRuleMatchers,
  namedRulePickerKinds,
  namedRuleRowState,
  newNameProblem,
  parseShareInput,
  planNamedRulePick,
  windowFromInputs,
} from "./named-rule-picker";
import { type LiveMeta, resolveSchema } from "./resolve-schema";

/** The four built-ins as `deco schema` (the blocks stack) lists them. */
const V8_META = {
  manifest: {
    blocks: {
      matchers: {
        always: { $ref: "#/definitions/YWx3YXlz", namespace: "deco" },
        experiment: {
          $ref: "#/definitions/ZXhwZXJpbWVudA==",
          namespace: "deco",
        },
        campaign: { $ref: "#/definitions/Y2FtcGFpZ24=", namespace: "deco" },
      },
      content: {
        "split-traffic": {
          $ref: "#/definitions/c3BsaXQtdHJhZmZpYw==",
          namespace: "deco",
        },
        calendar: {
          $ref: "#/definitions/Y2FsZW5kYXI=",
          namespace: "deco",
        },
      },
    },
  },
} as unknown as LiveMeta;

/** A v7 site: its own matchers, no built-ins. */
const V7_META = {
  manifest: {
    blocks: {
      matchers: {
        "website/matchers/random.ts": { $ref: "#/definitions/x" },
        "website/matchers/date.ts": { $ref: "#/definitions/y" },
      },
    },
  },
} as unknown as LiveMeta;

const experiments = { __resolveType: "split-traffic", "hero-test": 50 };
const campaigns = {
  __resolveType: "calendar",
  "black-friday": {
    start: "2026-11-27T00:00:00-03:00",
    end: "2026-12-01T00:00:00-03:00",
  },
  "always-on": {},
};

describe("namedRulePickerKinds", () => {
  it("offers both kinds on a v8 site, with each saved name", () => {
    const kinds = namedRulePickerKinds(V8_META, { experiments, campaigns });
    expect(kinds.map((k) => [k.kind, k.state])).toEqual([
      ["experiments", "saved"],
      ["campaigns", "saved"],
    ]);
    expect(kinds[0]!.entries).toEqual([
      { name: "hero-test", summary: "50% of visitors" },
    ]);
    expect(kinds[1]!.entries.map((e) => e.name)).toEqual([
      "black-friday",
      "always-on",
    ]);
    // A window with no dates has nothing to add; the picker says "always".
    expect(kinds[1]!.entries[1]!.summary).toBe("");
  });

  it("offers a kind whose block isn't saved yet: the first create makes it", () => {
    const kinds = namedRulePickerKinds(V8_META, {});
    expect(kinds.map((k) => [k.kind, k.state, k.entries.length])).toEqual([
      ["experiments", "absent", 0],
      ["campaigns", "absent", 0],
    ]);
  });

  it("lists nothing to pick under a block of that name with another type", () => {
    const kinds = namedRulePickerKinds(V8_META, {
      experiments: { __resolveType: "hero", title: "x" },
    });
    expect(kinds[0]).toEqual({
      kind: "experiments",
      state: "conflict",
      entries: [],
    });
  });

  it("offers nothing on a v7 site, or without a schema", () => {
    expect(namedRulePickerKinds(V7_META, { experiments })).toEqual([]);
    expect(namedRulePickerKinds(null, { experiments })).toEqual([]);
  });

  it("names the raw rules the items stand in for", () => {
    const kinds = namedRulePickerKinds(V8_META, {});
    expect([...namedRuleMatchers(kinds)]).toEqual(["experiment", "campaign"]);
  });
});

describe("new names and values", () => {
  it("refuses an empty, taken or reserved name", () => {
    expect(newNameProblem("  ", [])).toBe("empty");
    expect(newNameProblem("hero-test", ["hero-test"])).toBe("taken");
    expect(newNameProblem(" hero-test ", ["hero-test"])).toBe("taken");
    expect(newNameProblem("__resolveType", [])).toBe("reserved");
    expect(newNameProblem("Black Friday", ["hero-test"])).toBeNull();
  });

  it("takes a whole share from 0 to 100", () => {
    expect(parseShareInput("50")).toBe(50);
    expect(parseShareInput(" 0 ")).toBe(0);
    expect(parseShareInput("100")).toBe(100);
    for (const bad of ["101", "-1", "10.5", "", "fifty", "1e2"]) {
      expect(parseShareInput(bad)).toBeNull();
    }
  });

  it("saves a picked moment with the offset the editor's clock has that day", () => {
    const iso = localInputToIso("2026-11-27T09:30")!;
    expect(iso).toMatch(/^2026-11-27T09:30:00[+-]\d{2}:\d{2}$/);
    const back = new Date(iso);
    expect([back.getFullYear(), back.getMonth(), back.getDate()]).toEqual([
      2026, 10, 27,
    ]);
    expect([back.getHours(), back.getMinutes()]).toEqual([9, 30]);
    expect(isoToLocalInput(iso)).toBe("2026-11-27T09:30");
    expect(localInputToIso("")).toBeNull();
    expect(localInputToIso("tomorrow")).toBeNull();
    expect(isoToLocalInput(undefined)).toBe("");
    expect(isoToLocalInput("not a date")).toBe("");
  });

  it("leaves a cleared date out of the window, never saving an empty string", () => {
    const only = windowFromInputs("2026-11-27T00:00", "");
    expect("window" in only && Object.keys(only.window)).toEqual(["start"]);
    const none = windowFromInputs("", "");
    expect(none).toEqual({ window: {} });
  });

  it("asks for an end after the start", () => {
    expect(windowFromInputs("2026-12-01T00:00", "2026-11-27T00:00")).toEqual({
      problem: "end-before-start",
    });
    expect(windowFromInputs("2026-12-01T00:00", "2026-12-01T00:00")).toEqual({
      problem: "end-before-start",
    });
  });

  it("starts a campaign from an inline date rule's dates", () => {
    expect(
      inlineDateWindow({
        __resolveType: "date",
        start: "2026-11-27T00:00:00-03:00",
        end: "",
      }),
    ).toEqual({ start: "2026-11-27T00:00:00-03:00" });
    expect(inlineDateWindow({ __resolveType: "campaign", name: "x" })).toBe(
      null,
    );
    expect(inlineDateWindow({ __resolveType: "always" })).toBeNull();
  });
});

describe("planNamedRulePick", () => {
  it("picking an existing name writes only the rule", () => {
    expect(
      planNamedRulePick(
        { experiments },
        { kind: "experiments", name: "hero-test" },
      ),
    ).toEqual({
      ok: true,
      rule: { __resolveType: "experiment", name: "hero-test" },
      blockWrite: null,
    });
    expect(
      planNamedRulePick({}, { kind: "campaigns", name: " black-friday " }),
    ).toEqual({
      ok: true,
      rule: { __resolveType: "campaign", name: "black-friday" },
      blockWrite: null,
    });
  });

  it("creating adds the name to the block, keeping the others", () => {
    expect(
      planNamedRulePick(
        { experiments },
        { kind: "experiments", name: "cta-test", create: { share: 10 } },
      ),
    ).toEqual({
      ok: true,
      rule: { __resolveType: "experiment", name: "cta-test" },
      blockWrite: {
        blockKey: "experiments",
        block: {
          __resolveType: "split-traffic",
          "hero-test": 50,
          "cta-test": 10,
        },
      },
    });
  });

  it("creating the first campaign makes the block", () => {
    const window = { start: "2026-11-27T00:00:00-03:00" };
    expect(
      planNamedRulePick(
        {},
        { kind: "campaigns", name: "Black Friday", create: { window } },
      ),
    ).toEqual({
      ok: true,
      rule: { __resolveType: "campaign", name: "Black Friday" },
      blockWrite: {
        blockKey: "campaigns",
        block: { __resolveType: "calendar", "Black Friday": window },
      },
    });
  });

  it("uses a name created meanwhile as it is, never replacing its value", () => {
    const plan = planNamedRulePick(
      { experiments },
      { kind: "experiments", name: "hero-test", create: { share: 90 } },
    );
    expect(plan).toMatchObject({ ok: true, blockWrite: null });
  });

  it("writes nothing over a block of that name with another type", () => {
    expect(
      planNamedRulePick(
        { campaigns: { __resolveType: "hero" } },
        { kind: "campaigns", name: "x", create: { window: {} } },
      ),
    ).toEqual({ ok: false, reason: "conflict" });
    expect(planNamedRulePick({}, { kind: "experiments", name: "  " })).toEqual({
      ok: false,
      reason: "empty",
    });
  });
});

describe("the rule editor's row", () => {
  const kinds = namedRulePickerKinds(V8_META, { experiments, campaigns });

  it("shows a named test with its share", () => {
    const rule = { __resolveType: "experiment", name: "hero-test" };
    expect(currentNamedRule(rule, kinds)).toMatchObject({
      kind: "experiments",
      name: "hero-test",
    });
    expect(namedRuleRowState(rule, kinds)).toEqual({
      kind: "experiments",
      name: "hero-test",
      summary: "50% of visitors",
      missing: false,
      conflict: false,
      inlineDate: false,
    });
  });

  it("says when the name isn't in the block", () => {
    expect(
      namedRuleRowState({ __resolveType: "campaign", name: "gone" }, kinds),
    ).toMatchObject({ kind: "campaigns", name: "gone", missing: true });
  });

  it("isn't missing when the kind's block holds something else: that has its own explanation", () => {
    expect(
      namedRuleRowState({ __resolveType: "experiment", name: "gone" }, [
        { kind: "experiments", state: "conflict", entries: [] },
      ]),
    ).toEqual({
      kind: "experiments",
      name: "gone",
      summary: "",
      missing: false,
      conflict: true,
      inlineDate: false,
    });
  });

  it("guides an inline date rule into a campaign", () => {
    expect(
      namedRuleRowState(
        { __resolveType: "date", start: "2026-01-01T00:00:00Z" },
        kinds,
      ),
    ).toMatchObject({ kind: "campaigns", inlineDate: true, conflict: false });
  });

  it("an inline date rule on a site whose campaigns block holds something else gets that explanation", () => {
    expect(
      namedRuleRowState(
        { __resolveType: "date", start: "2026-01-01T00:00:00Z" },
        [{ kind: "campaigns", state: "conflict", entries: [] }],
      ),
    ).toMatchObject({ kind: "campaigns", inlineDate: true, conflict: true });
  });

  it("leaves other rules, and sites without the kinds, as they are", () => {
    expect(namedRuleRowState({ __resolveType: "always" }, kinds)).toBeNull();
    expect(
      namedRuleRowState({ __resolveType: "experiment", name: "x" }, []),
    ).toBeNull();
  });
});

describe("a test or campaign named inside a rule", () => {
  const kinds = namedRulePickerKinds(V8_META, { experiments, campaigns });
  const gone = { __resolveType: "experiment", name: "gone" };

  it("is pointed out inside a multi, a lazy value and a saved rule", () => {
    expect(
      missingNamedRuleWithin(
        { __resolveType: "multi", op: "and", matchers: [gone] },
        kinds,
        {},
      ),
    ).toBe("experiments");
    expect(
      missingNamedRuleWithin(
        {
          __resolveType: "lazy",
          value: { __resolveType: "campaign", name: "x" },
        },
        kinds,
        {},
      ),
    ).toBe("campaigns");
    const decofile = {
      "Saved rule": { __resolveType: "multi", matchers: [gone] },
      Outer: { __resolveType: "Saved rule" },
    };
    expect(
      missingNamedRuleWithin({ __resolveType: "Outer" }, kinds, decofile),
    ).toBe("experiments");
  });

  it("says nothing when the names exist, for the locked row, or in a cycle", () => {
    const ok = { __resolveType: "experiment", name: "hero-test" };
    expect(
      missingNamedRuleWithin(
        { __resolveType: "multi", matchers: [ok] },
        kinds,
        {},
      ),
    ).toBeNull();
    // The row under the picker already says it for a rule that is the name.
    expect(missingNamedRuleWithin(gone, kinds, {})).toBeNull();
    expect(
      missingNamedRuleWithin({ __resolveType: "A" }, kinds, {
        A: { __resolveType: "B" },
        B: { __resolveType: "A" },
      }),
    ).toBeNull();
    expect(
      missingNamedRuleWithin(
        { __resolveType: "multi", matchers: [gone] },
        [],
        {},
      ),
    ).toBeNull();
  });
});

describe("a section prop that reads a whole block", () => {
  const kinds = namedRulePickerKinds(V8_META, { experiments });
  const schema = {
    type: "block-ref",
    anyOfRefs: [{ resolveType: "split-traffic" }, { resolveType: "calendar" }],
  };

  it("offers the kinds whose type fits, while the value is empty or such a reference", () => {
    expect(namedRuleBlockFieldKinds(schema, undefined, kinds)).toEqual([
      "experiments",
      "campaigns",
    ]);
    expect(namedRuleBlockFieldKinds(schema, {}, kinds)).toEqual([
      "experiments",
      "campaigns",
    ]);
    expect(
      namedRuleBlockFieldKinds(schema, { __resolveType: "campaigns" }, kinds),
    ).toEqual(["experiments", "campaigns"]);
    expect(
      namedRuleBlockFieldKinds(
        { type: "block-ref", anyOfRefs: [{ resolveType: "split-traffic" }] },
        undefined,
        kinds,
      ),
    ).toEqual(["experiments"]);
  });

  it("keeps the usual form for a plain map, another block, or a v7 site", () => {
    expect(namedRuleBlockFieldKinds(schema, { a: true }, kinds)).toEqual([]);
    expect(
      namedRuleBlockFieldKinds(schema, { __resolveType: "my-flags" }, kinds),
    ).toEqual([]);
    expect(namedRuleBlockFieldKinds(schema, undefined, [])).toEqual([]);
    expect(
      namedRuleBlockFieldKinds({ type: "object" }, undefined, kinds),
    ).toEqual([]);
  });

  it("reads only a bare reference to the saved block", () => {
    expect(namedRuleBlockFieldValue({ __resolveType: "experiments" })).toBe(
      "experiments",
    );
    expect(namedRuleBlockFieldValue({ __resolveType: "campaigns" })).toBe(
      "campaigns",
    );
    expect(
      namedRuleBlockFieldValue({ __resolveType: "experiments", a: 1 }),
    ).toBeNull();
    expect(namedRuleBlockFieldValue({ __resolveType: "split-traffic" })).toBe(
      null,
    );
    expect(namedRuleBlockFieldValue(null)).toBeNull();
  });
});

/**
 * A section with `experiments?: Assignments` and `labels: Record<string,
 * string>`, its definitions as the blocks stack's `deco schema` writes them.
 */
const PROPS_META = {
  manifest: {
    blocks: {
      sections: {
        hero: {
          $ref: "#/definitions/aGVybw==",
          namespace: "site",
        },
      },
      content: {
        "split-traffic": {
          $ref: "#/definitions/c3BsaXQtdHJhZmZpYw==",
          namespace: "deco",
        },
        calendar: {
          $ref: "#/definitions/Y2FsZW5kYXI=",
          namespace: "deco",
        },
      },
    },
  },
  schema: {
    definitions: {
      Resolvable: {
        title: "Select from saved",
        type: "object",
        required: ["__resolveType"],
        additionalProperties: true,
        properties: {
          __resolveType: {
            type: "string",
          },
        },
      },
      "QGRlY29jbXMvYmxvY2tzL3NyYy92OC9leHBlcmltZW50cy50cw==@Assignments": {
        type: "object",
        additionalProperties: {
          type: "boolean",
        },
      },
      "c3BsaXQtdHJhZmZpYw==": {
        title: "split-traffic",
        description:
          "A/B tests: each name with the percentage of visitors in it (0 off, 100 everyone); resolves to whether the visitor is in each. The type of the saved block experiments",
        icon: "flask",
        additionalProperties: {
          type: "integer",
          title: "Visitors in (%)",
          description: "0 turns the test off, 100 shows it to everyone",
          minimum: 0,
          maximum: 100,
        },
        type: "object",
        required: ["__resolveType"],
        properties: {
          __resolveType: {
            type: "string",
            enum: ["split-traffic"],
            default: "split-traffic",
          },
        },
      },
      "Y2FsZW5kYXI=": {
        title: "calendar",
        description:
          "Campaigns: each name with its start and end; resolves to whether each is running now. The type of the saved block campaigns",
        icon: "calendar-event",
        additionalProperties: {
          type: "object",
          title: "Campaign dates",
          properties: {
            start: {
              type: "string",
              format: "date-time",
              title: "Start",
              description:
                "The campaign runs from this moment on (empty: since always)",
            },
            end: {
              type: "string",
              format: "date-time",
              title: "End",
              description: "The campaign stops at this moment (empty: never)",
            },
          },
        },
        type: "object",
        required: ["__resolveType"],
        properties: {
          __resolveType: {
            type: "string",
            enum: ["calendar"],
            default: "calendar",
          },
        },
      },
      "aGVybw==": {
        title: "hero",
        type: "object",
        required: ["__resolveType"],
        properties: {
          __resolveType: {
            type: "string",
            enum: ["hero"],
            default: "hero",
          },
          experiments: {
            anyOf: [
              {
                $ref: "#/definitions/Resolvable",
              },
              {
                $ref: "#/definitions/QGRlY29jbXMvYmxvY2tzL3NyYy92OC9leHBlcmltZW50cy50cw==@Assignments",
                title: "Inline data",
              },
              {
                $ref: "#/definitions/c3BsaXQtdHJhZmZpYw==",
              },
              {
                $ref: "#/definitions/Y2FsZW5kYXI=",
              },
            ],
            nullable: true,
            title: "Experiments",
          },
          // `campaigns?: Record<string, boolean>`: the inline branch is
          // written in place, not as a `$ref` (the stack's real output).
          campaigns: {
            anyOf: [
              { $ref: "#/definitions/Resolvable" },
              {
                type: "object",
                additionalProperties: { type: "boolean" },
                title: "Inline data",
              },
              { $ref: "#/definitions/c3BsaXQtdHJhZmZpYw==" },
              { $ref: "#/definitions/Y2FsZW5kYXI=" },
            ],
            nullable: true,
            title: "Campaigns",
          },
          labels: {
            type: "object",
            additionalProperties: {
              type: "string",
            },
            title: "Labels",
          },
        },
      },
    },
  },
} as unknown as LiveMeta;

describe("the schema of a prop that reads a whole block", () => {
  it("resolves to the two built-ins as the blocks that fit it", () => {
    const hero = resolveSchema("hero", PROPS_META)!;
    const field = hero.properties!.experiments!;
    expect(field.type).toBe("block-ref");
    const kinds = namedRulePickerKinds(V8_META, {});
    expect(namedRuleBlockFieldKinds(field, undefined, kinds)).toEqual([
      "experiments",
      "campaigns",
    ]);
    // Typed `Record<string, boolean>`, written inline: the same two.
    const campaigns = hero.properties!.campaigns!;
    expect(campaigns.type).toBe("block-ref");
    expect(namedRuleBlockFieldKinds(campaigns, undefined, kinds)).toEqual([
      "experiments",
      "campaigns",
    ]);
    // A string map has no block that fits: it keeps its usual form.
    expect(
      namedRuleBlockFieldKinds(hero.properties!.labels!, undefined, kinds),
    ).toEqual([]);
  });
});
