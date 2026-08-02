import { describe, expect, test } from "bun:test";
import type { TiptapDoc } from "../../types.ts";
import {
  extractPlainTextFromTiptapDoc,
  replaceSecretInTiptapDoc,
} from "./replace.ts";

const TOKEN = "sk-abcdEFGH1234567890wxyzABCD";
const ATTRS = { name: "openai_api_key", secretId: "sec_123" };

function doc(...paragraphs: TiptapDoc["content"]): TiptapDoc {
  return { type: "doc", content: paragraphs };
}

describe("replaceSecretInTiptapDoc", () => {
  test("splits a text node around the token", () => {
    const d = doc({
      type: "paragraph",
      content: [{ type: "text", text: `use ${TOKEN} please` }],
    });
    const out = replaceSecretInTiptapDoc(d, TOKEN, ATTRS)!;
    expect(out.content[0]!.content).toEqual([
      { type: "text", text: "use " },
      { type: "secretRef", attrs: ATTRS },
      { type: "text", text: " please" },
    ]);
  });

  test("token alone in the node produces just the chip", () => {
    const d = doc({
      type: "paragraph",
      content: [{ type: "text", text: TOKEN }],
    });
    const out = replaceSecretInTiptapDoc(d, TOKEN, ATTRS)!;
    expect(out.content[0]!.content).toEqual([
      { type: "secretRef", attrs: ATTRS },
    ]);
  });

  test("preserves marks on the split pieces", () => {
    const marks = [{ type: "bold" }];
    const d = doc({
      type: "paragraph",
      content: [{ type: "text", text: `a ${TOKEN} b`, marks }],
    });
    const out = replaceSecretInTiptapDoc(d, TOKEN, ATTRS)!;
    const pieces = out.content[0]!.content!;
    expect(pieces[0]).toEqual({ type: "text", text: "a ", marks });
    expect(pieces[2]).toEqual({ type: "text", text: " b", marks });
  });

  test("replaces only the first occurrence", () => {
    const d = doc({
      type: "paragraph",
      content: [{ type: "text", text: `${TOKEN} and ${TOKEN}` }],
    });
    const out = replaceSecretInTiptapDoc(d, TOKEN, ATTRS)!;
    const pieces = out.content[0]!.content!;
    expect(pieces.filter((p) => p.type === "secretRef")).toHaveLength(1);
    expect(pieces.at(-1)?.text).toBe(` and ${TOKEN}`);
  });

  test("finds the token in a later paragraph", () => {
    const d = doc(
      { type: "paragraph", content: [{ type: "text", text: "hello" }] },
      { type: "paragraph", content: [{ type: "text", text: TOKEN }] },
    );
    const out = replaceSecretInTiptapDoc(d, TOKEN, ATTRS)!;
    expect(out.content[0]!.content).toEqual([{ type: "text", text: "hello" }]);
    expect(out.content[1]!.content).toEqual([
      { type: "secretRef", attrs: ATTRS },
    ]);
  });

  test("returns null when the token is absent", () => {
    const d = doc({
      type: "paragraph",
      content: [{ type: "text", text: "nothing here" }],
    });
    expect(replaceSecretInTiptapDoc(d, TOKEN, ATTRS)).toBeNull();
  });

  test("does not mutate the input doc", () => {
    const d = doc({
      type: "paragraph",
      content: [{ type: "text", text: TOKEN }],
    });
    const snapshot = JSON.stringify(d);
    replaceSecretInTiptapDoc(d, TOKEN, ATTRS);
    expect(JSON.stringify(d)).toBe(snapshot);
  });
});

describe("extractPlainTextFromTiptapDoc", () => {
  test("joins paragraphs with newlines, skips atom nodes", () => {
    const d = doc(
      {
        type: "paragraph",
        content: [
          { type: "text", text: "use " },
          { type: "secretRef", attrs: ATTRS },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "second" }] },
    );
    expect(extractPlainTextFromTiptapDoc(d)).toBe("use \nsecond");
  });

  test("empty for undefined doc", () => {
    expect(extractPlainTextFromTiptapDoc(undefined)).toBe("");
  });
});
