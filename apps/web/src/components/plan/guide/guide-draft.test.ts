import { describe, expect, it } from "bun:test";
import { BUSINESS_CASE_LIMITS } from "@decocms/shared/business-case";
import {
  clearGuideDraft,
  guideFromDraft,
  readGuideDraft,
  writeGuideDraft,
} from "./guide-draft.ts";
import { guideReducer, startGuide, type GuideState } from "./guide-state.ts";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    items,
  };
}

const ORG = "org-1";
const NOW = 1_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** One question answered, the next one on screen. */
function midway(): GuideState {
  let state = startGuide("Free shipping over R$ 300");
  state = guideReducer(state, {
    type: "resolved",
    step: 0,
    result: {
      reaction: null,
      question: { text: "Where should it show?", options: ["Cart"] },
      title: "Free shipping over R$ 300 in the cart",
    },
  });
  state = guideReducer(state, { type: "answered", step: 0, answer: "Cart" });
  return guideReducer(state, {
    type: "resolved",
    step: 1,
    result: {
      reaction: "Good.",
      question: { text: "How will you measure it?", options: [] },
      title: null,
    },
  });
}

describe("guide draft", () => {
  it("resumes an unfinished intro at the next question", () => {
    const storage = memoryStorage();
    writeGuideDraft(storage, ORG, midway(), NOW);
    const draft = readGuideDraft(storage, ORG, NOW);
    expect(draft?.done).toBeNull();
    expect(guideFromDraft(draft!)).toEqual({
      step: 1,
      idea: "Free shipping over R$ 300",
      answers: [{ question: "Where should it show?", answer: "Cart" }],
      asked: [{ text: "Where should it show?", options: [] }],
      title: "Free shipping over R$ 300 in the cart",
      view: { phase: "thinking" },
    });
  });

  it("resumes a finished intro ready to open, guided or not", () => {
    const storage = memoryStorage();
    const answered = guideReducer(midway(), {
      type: "answered",
      step: 1,
      answer: "",
    });
    const failed = guideReducer(answered, { type: "failed", step: 2 });
    writeGuideDraft(storage, ORG, failed, NOW);
    const state = guideFromDraft(readGuideDraft(storage, ORG, NOW)!);
    expect(state.view).toEqual({ phase: "building", guided: false });
    expect(state.step).toBe(2);
    expect(state.answers).toHaveLength(2);
  });

  it("keeps one draft per organization", () => {
    const storage = memoryStorage();
    writeGuideDraft(storage, ORG, midway(), NOW);
    expect(readGuideDraft(storage, "org-2", NOW)).toBeNull();
    clearGuideDraft(storage, ORG);
    expect(readGuideDraft(storage, ORG, NOW)).toBeNull();
  });

  it("drops a draft that is too old or does not parse", () => {
    const storage = memoryStorage();
    writeGuideDraft(storage, ORG, midway(), NOW);
    expect(readGuideDraft(storage, ORG, NOW + 8 * DAY)).toBeNull();
    expect(storage.items.size).toBe(0);

    storage.setItem(`studio:plan-guide-draft:${ORG}`, "{not json");
    expect(readGuideDraft(storage, ORG, NOW)).toBeNull();
    storage.setItem(
      `studio:plan-guide-draft:${ORG}`,
      JSON.stringify({ idea: "", answers: [], title: null, done: null }),
    );
    expect(readGuideDraft(storage, ORG, NOW)).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it("cuts oversized text so the saved draft still reads back", () => {
    const storage = memoryStorage();
    const long = "x".repeat(10_000);
    writeGuideDraft(
      storage,
      ORG,
      {
        ...midway(),
        idea: long,
        title: long,
        answers: [{ question: long, answer: long }],
      },
      NOW,
    );
    const draft = readGuideDraft(storage, ORG, NOW);
    expect(draft?.idea.length).toBe(4000);
    expect(draft?.title?.length).toBe(BUSINESS_CASE_LIMITS.title);
    expect(draft?.answers[0]?.question.length).toBe(BUSINESS_CASE_LIMITS.item);
    expect(draft?.answers[0]?.answer.length).toBe(BUSINESS_CASE_LIMITS.text);
  });

  it("keeps the intro running when storage refuses the write", () => {
    const storage = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => writeGuideDraft(storage, ORG, midway(), NOW)).not.toThrow();
    expect(readGuideDraft(storage, ORG, NOW)).toBeNull();
  });
});
