import { describe, expect, test } from "bun:test";
import {
  canSubmit,
  findIndexByKey,
  findNextUnansweredKey,
  isAllAnswered,
} from "./multipart-decision-form-helpers";

type Part = { id: string };
const partKey = (p: Part) => p.id;
const hasAnswer = (v: unknown) =>
  typeof (v as { decided?: boolean } | undefined)?.decided === "boolean";

describe("findIndexByKey", () => {
  test("returns the index of a matching part", () => {
    const parts: Part[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(findIndexByKey(parts, partKey, "b")).toBe(1);
  });

  test("returns -1 when no match", () => {
    const parts: Part[] = [{ id: "a" }, { id: "b" }];
    expect(findIndexByKey(parts, partKey, "z")).toBe(-1);
  });
});

describe("isAllAnswered", () => {
  test("false for an empty parts list", () => {
    expect(isAllAnswered<Part>([], partKey, {}, hasAnswer)).toBe(false);
  });

  test("false when at least one part is unanswered", () => {
    const parts: Part[] = [{ id: "a" }, { id: "b" }];
    const values = { a: { decided: true }, b: { decided: undefined } };
    expect(isAllAnswered(parts, partKey, values, hasAnswer)).toBe(false);
  });

  test("true when every part is answered", () => {
    const parts: Part[] = [{ id: "a" }, { id: "b" }];
    const values = { a: { decided: true }, b: { decided: false } };
    expect(isAllAnswered(parts, partKey, values, hasAnswer)).toBe(true);
  });
});

describe("findNextUnansweredKey", () => {
  test("returns the next unanswered part after `fromKey`", () => {
    const parts: Part[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const values = { a: { decided: true } };
    expect(findNextUnansweredKey(parts, partKey, values, hasAnswer, "a")).toBe(
      "b",
    );
  });

  test("skips the current key when looking for unanswered", () => {
    const parts: Part[] = [{ id: "a" }, { id: "b" }];
    const values = { a: undefined, b: { decided: true } };
    // We're on "a", but "a" is unanswered — we still skip it and find none.
    expect(findNextUnansweredKey(parts, partKey, values, hasAnswer, "a")).toBe(
      null,
    );
  });

  test("wraps around the list", () => {
    const parts: Part[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const values = { b: { decided: true } };
    expect(findNextUnansweredKey(parts, partKey, values, hasAnswer, "c")).toBe(
      "a",
    );
  });

  test("returns null when every other part is answered", () => {
    const parts: Part[] = [{ id: "a" }, { id: "b" }];
    const values = { a: undefined, b: { decided: true } };
    expect(findNextUnansweredKey(parts, partKey, values, hasAnswer, "a")).toBe(
      null,
    );
  });

  test("returns null for an empty parts list", () => {
    expect(findNextUnansweredKey<Part>([], partKey, {}, hasAnswer, "x")).toBe(
      null,
    );
  });

  test("returns the first unanswered when fromKey is not in parts", () => {
    const parts: Part[] = [{ id: "a" }, { id: "b" }];
    const values = { a: undefined, b: { decided: true } };
    expect(findNextUnansweredKey(parts, partKey, values, hasAnswer, "z")).toBe(
      "a",
    );
  });
});

describe("canSubmit", () => {
  test("true only when not streaming and all answered", () => {
    expect(canSubmit({ isStreaming: false, allAnswered: true })).toBe(true);
  });

  test("false when streaming", () => {
    expect(canSubmit({ isStreaming: true, allAnswered: true })).toBe(false);
  });

  test("false when not all answered", () => {
    expect(canSubmit({ isStreaming: false, allAnswered: false })).toBe(false);
  });

  test("false when streaming and not all answered", () => {
    expect(canSubmit({ isStreaming: true, allAnswered: false })).toBe(false);
  });
});
