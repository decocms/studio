import { describe, expect, it } from "bun:test";
import {
  carryConflictChoices,
  chooseAll,
  conflictFields,
  defaultConflictChoices,
  diffWords,
  planFormConflict,
  previewValue,
  refreshWaitingChoice,
  resolveFormConflict,
  setAtPointer,
  summarizeValue,
  valueAtPointer,
} from "./form-conflict";
import type { SchemaProperty } from "./resolve-schema";

const ancestor = {
  __resolveType: "site/sections/Hero.tsx",
  headline: "Original headline",
  subtitle: "Original subtitle",
  slides: [{ title: "First", description: "Original description" }],
};

const schema: SchemaProperty = {
  type: "object",
  properties: {
    headline: { type: "string", title: "Headline" },
    subtitle: { type: "string", title: "Subtitle" },
    slides: {
      type: "array",
      title: "Slides",
      items: {
        type: "object",
        properties: {
          title: { type: "string", title: "Title" },
          description: { type: "string", title: "Description" },
        },
      },
    },
  },
};

describe("planFormConflict", () => {
  it("merges values only one side changed without asking", () => {
    const plan = planFormConflict({
      ancestor,
      mine: { ...ancestor, headline: "Mine" },
      theirs: { ...ancestor, subtitle: "Theirs" },
    });
    expect(plan.pointers).toEqual([]);
    expect(plan.merged).toEqual({
      ...ancestor,
      headline: "Mine",
      subtitle: "Theirs",
    });
  });

  it("lists the values both changed to different things, keeping theirs in the merge", () => {
    const plan = planFormConflict({
      ancestor,
      mine: { ...ancestor, headline: "Mine", subtitle: "My subtitle" },
      theirs: { ...ancestor, headline: "Theirs" },
    });
    expect(plan.pointers).toEqual(["/headline"]);
    expect(plan.merged).toEqual({
      ...ancestor,
      headline: "Theirs",
      subtitle: "My subtitle",
    });
  });

  it("does not ask when both changed a value to the same thing", () => {
    const plan = planFormConflict({
      ancestor,
      mine: { ...ancestor, headline: "Same" },
      theirs: { ...ancestor, headline: "Same" },
    });
    expect(plan.pointers).toEqual([]);
  });
});

describe("resolveFormConflict", () => {
  const plan = planFormConflict({
    ancestor,
    mine: {
      ...ancestor,
      headline: "My headline",
      subtitle: "My subtitle",
      slides: [{ title: "First", description: "My description" }],
    },
    theirs: {
      ...ancestor,
      headline: "Their headline",
      subtitle: "Their subtitle",
      slides: [{ title: "First", description: "Their description" }],
    },
  });

  it("keeps the version picked for each value", () => {
    expect(plan.pointers).toEqual([
      "/headline",
      "/subtitle",
      "/slides/0/description",
    ]);
    const resolved = resolveFormConflict(plan, {
      "/headline": "mine",
      "/subtitle": "theirs",
      "/slides/0/description": "mine",
    });
    expect(resolved).toEqual({
      ...ancestor,
      headline: "My headline",
      subtitle: "Their subtitle",
      slides: [{ title: "First", description: "My description" }],
    });
  });

  it("keep all mine / use all theirs", () => {
    expect(resolveFormConflict(plan, chooseAll(plan, "mine"))).toEqual(
      plan.mine,
    );
    expect(resolveFormConflict(plan, chooseAll(plan, "theirs"))).toEqual(
      plan.theirs,
    );
  });

  it("leaves the inputs untouched", () => {
    const merged = JSON.stringify(plan.merged);
    resolveFormConflict(plan, chooseAll(plan, "mine"));
    expect(JSON.stringify(plan.merged)).toBe(merged);
  });

  it("removes a value the user cleared when they keep mine", () => {
    const cleared = planFormConflict({
      ancestor,
      mine: { ...ancestor, subtitle: undefined },
      theirs: { ...ancestor, subtitle: "Theirs" },
    });
    expect(cleared.pointers).toEqual(["/subtitle"]);
    const resolved = resolveFormConflict(cleared, { "/subtitle": "mine" });
    expect("subtitle" in resolved).toBe(false);
  });

  it("starts on yours for every value, so saving it as shown keeps the user's", () => {
    const choices = defaultConflictChoices(plan);
    expect(Object.keys(choices)).toEqual(plan.pointers);
    expect(Object.values(choices).every((c) => c === "mine")).toBe(true);
    expect(resolveFormConflict(plan, choices)).toEqual(plan.mine);
  });
});

describe("carryConflictChoices", () => {
  const first = planFormConflict({
    ancestor,
    mine: { ...ancestor, headline: "Mine", subtitle: "My subtitle" },
    theirs: { ...ancestor, headline: "Theirs", subtitle: "Their subtitle" },
  });
  const choices = { "/headline": "theirs", "/subtitle": "theirs" } as const;

  it("keeps a choice while both versions of that value are the same, else starts on yours", () => {
    const again = planFormConflict({
      ...first,
      theirs: {
        ...first.theirs,
        subtitle: "Their newer subtitle",
        slides: [{ title: "Changed", description: "Original description" }],
      },
    });
    expect(carryConflictChoices(first, choices, again)).toEqual({
      "/headline": "theirs",
      "/subtitle": "mine",
    });
  });

  it("drops a choice for a value no longer in conflict", () => {
    const again = planFormConflict({
      ...first,
      theirs: { ...first.theirs, headline: "Mine" },
    });
    expect(again.pointers).toEqual(["/subtitle"]);
    expect(carryConflictChoices(first, choices, again)).toEqual({
      "/subtitle": "theirs",
    });
  });
});

describe("conflictFields", () => {
  it("names each value as the form labels it, with both versions", () => {
    const plan = planFormConflict({
      ancestor,
      mine: {
        ...ancestor,
        slides: [{ title: "First", description: "Mine" }],
      },
      theirs: {
        ...ancestor,
        slides: [{ title: "First", description: "Theirs" }],
      },
    });
    expect(conflictFields(plan, schema)).toEqual([
      {
        pointer: "/slides/0/description",
        label: "Slides › 1 › Description",
        mine: "Mine",
        theirs: "Theirs",
        schema: { type: "string", title: "Description" },
      },
    ]);
  });
});

describe("pointers", () => {
  it("reads and writes nested values without touching the original", () => {
    const root = { a: [{ b: 1 }, { b: 2 }], "x/y": { "~": 3 } };
    expect(valueAtPointer(root, "/a/1/b")).toBe(2);
    expect(valueAtPointer(root, "/x~1y/~0")).toBe(3);
    expect(valueAtPointer(root, "/missing/deep")).toBeUndefined();
    const written = setAtPointer(root, "/a/1/b", 5);
    expect(written).toEqual({ a: [{ b: 1 }, { b: 5 }], "x/y": { "~": 3 } });
    expect(root.a[1]?.b).toBe(2);
    expect(setAtPointer(root, "/x~1y/~0", undefined)).toEqual({
      a: root.a,
      "x/y": {},
    });
  });
});

describe("previewValue", () => {
  it("reads rich text as text: nested tags removed, each entity decoded once", () => {
    expect(previewValue("<p>a</p><p>b<br>c</p>", null)).toEqual({
      kind: "text",
      text: "a\nb\nc",
    });
    expect(previewValue("<p>x<scr<script>ipt>y</p>", null)).toMatchObject({
      kind: "text",
    });
    const nested = previewValue("<p>x<scr<script>ipt>y</p>", null);
    expect(nested.kind === "text" && nested.text.includes("<")).toBe(false);
    expect(
      previewValue("<p>&amp;lt;b&amp;gt; &amp; 1&nbsp;2</p>", null),
    ).toEqual({
      kind: "text",
      text: "&lt;b&gt; & 1 2",
    });
  });

  it("shows text, images, lists and small objects readably", () => {
    expect(previewValue("Hello", null)).toEqual({
      kind: "text",
      text: "Hello",
    });
    expect(previewValue("<p>Hello <b>world</b></p>", null)).toEqual({
      kind: "text",
      text: "Hello world",
    });
    expect(
      previewValue("https://cdn.example.com/banner.webp?w=200", null),
    ).toEqual({
      kind: "image",
      src: "https://cdn.example.com/banner.webp?w=200",
    });
    expect(
      previewValue("/assets/x", { type: "string", format: "image-uri" }),
    ).toEqual({ kind: "image", src: "/assets/x" });
    expect(previewValue(true, null)).toEqual({ kind: "yesNo", value: true });
    expect(previewValue("", null)).toEqual({ kind: "empty" });
    expect(
      previewValue(
        [
          { title: "One" },
          { title: "Two" },
          { title: "Three" },
          { title: "4" },
        ],
        null,
      ),
    ).toEqual({ kind: "list", count: 4, items: ["One", "Two", "Three"] });
    expect(
      previewValue(
        { __resolveType: "x", label: "Shop", href: "/shop" },
        {
          type: "object",
          properties: { label: { type: "string", title: "Label" } },
        },
      ),
    ).toEqual({
      kind: "fields",
      entries: [
        { label: "Label", text: "Shop" },
        { label: "href", text: "/shop" },
      ],
    });
    // A wrapped value reads as what it wraps.
    expect(previewValue({ __resolveType: "lazy", value: "Hi" }, null)).toEqual({
      kind: "text",
      text: "Hi",
    });
  });

  it("summarizes a value in one line", () => {
    const labels = {
      empty: "Empty",
      yes: "Yes",
      no: "No",
      items: (count: number) => `${count} items`,
    };
    expect(summarizeValue([1, 2], null, labels)).toBe("2 items");
    expect(summarizeValue(undefined, null, labels)).toBe("Empty");
    expect(
      summarizeValue("https://cdn.example.com/a/hero.png", null, labels),
    ).toBe("hero.png");
    expect(summarizeValue("x".repeat(100), null, labels)).toHaveLength(60);
  });
});

describe("diffWords", () => {
  const marked = (parts: Array<{ text: string; kind: string }>) =>
    parts.map((part) =>
      part.kind === "changed" ? `[${part.text}]` : part.text,
    );

  it("marks the words each version has that the other doesn't", () => {
    const { mine, theirs } = diffWords(
      "Summer sale on all shoes",
      "Winter sale on all boots",
    );
    expect(marked(mine).join("")).toBe("[Summer ]sale on all [shoes]");
    expect(marked(theirs).join("")).toBe("[Winter ]sale on all [boots]");
  });

  it("shows identical texts unmarked", () => {
    const { mine } = diffWords("Same text", "Same text");
    expect(mine).toEqual([{ text: "Same text", kind: "same" }]);
  });

  it("marks everything for an emptied text", () => {
    const { mine, theirs } = diffWords("", "Their text");
    expect(mine).toEqual([]);
    expect(marked(theirs).join("")).toBe("[Their text]");
  });
});

// The open dialog's poll read a newer stored copy (QA-8027 step 5).
describe("refreshWaitingChoice", () => {
  const plan = planFormConflict({
    ancestor,
    mine: { ...ancestor, headline: "Mine", subtitle: "My subtitle" },
    theirs: { ...ancestor, headline: "Theirs", subtitle: "Their subtitle" },
  });
  const waiting = {
    plan,
    choices: { "/headline": "theirs", "/subtitle": "theirs" } as const,
  };
  const notOwn = () => false;

  it("shows their newer version in place, keeping the picks that still apply", () => {
    const newer = { ...plan.theirs, subtitle: "Their newer subtitle" };
    const refreshed = refreshWaitingChoice(waiting, newer, notOwn);
    expect(refreshed?.plan.theirs).toEqual(newer);
    expect(refreshed?.plan.mine).toEqual(plan.mine);
    expect(refreshed?.plan.pointers).toEqual(["/headline", "/subtitle"]);
    expect(refreshed?.choices).toEqual({
      "/headline": "theirs",
      "/subtitle": "mine",
    });
  });

  it("leaves the dialog as it is for the same copy, its own save, another section type or no copy", () => {
    expect(
      refreshWaitingChoice(waiting, { ...plan.theirs }, notOwn),
    ).toBeNull();
    const newer = { ...plan.theirs, headline: "Newer" };
    expect(refreshWaitingChoice(waiting, newer, () => true)).toBeNull();
    expect(
      refreshWaitingChoice(
        waiting,
        { ...newer, __resolveType: "site/sections/Other.tsx" },
        notOwn,
      ),
    ).toBeNull();
    expect(refreshWaitingChoice(waiting, null, notOwn)).toBeNull();
  });

  it("keeps the choice as asked when no clash is left", () => {
    const agrees = {
      ...plan.theirs,
      headline: "Mine",
      subtitle: "My subtitle",
    };
    expect(refreshWaitingChoice(waiting, agrees, notOwn)).toBeNull();
  });
});
