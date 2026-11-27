import { describe, expect, test } from "bun:test";
import { type MessageRow, toChat, toMedia } from "./to-chat.ts";

const row = (over: Partial<MessageRow>): MessageRow => ({
  connection_id: "chan_1",
  conversation_id: "group-1",
  id: "m1",
  author_id: null,
  author_name: null,
  ts: "2026-11-27T12:00:00.000Z",
  text: null,
  derived_text: null,
  kind: null,
  reply_to: null,
  thread_id: null,
  attachments: null,
  offset_ms: null,
  duration_ms: null,
  edited_at: null,
  deleted_at: null,
  withheld: false,
  ...over,
});

describe("toChat", () => {
  test("turns the tool's newest-first rows into a conversation read oldest first", () => {
    const chat = toChat([
      row({ id: "m2", ts: "2026-11-27T12:01:00.000Z", text: "second" }),
      row({ id: "m1", text: "first" }),
    ]);
    expect(chat.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  test("names a WhatsApp author and puts their number beside the name", () => {
    const [m] = toChat([
      row({ author_id: "5511900000001@s.whatsapp.net", author_name: "Ana" }),
    ]);
    expect(m?.author).toEqual({
      id: "5511900000001@s.whatsapp.net",
      name: "Ana",
      handle: "+5511900000001",
    });
  });

  test("reads an author with only a phone id as the number", () => {
    const [m] = toChat([row({ author_id: "5511900000002" })]);
    expect(m?.author?.name).toBe("+5511900000002");
    expect(m?.author?.handle).toBeNull();
  });

  test("quotes the replied message when it is among the loaded ones", () => {
    const chat = toChat([
      row({ id: "m2", reply_to: "m1", text: "yes", author_name: "Bia" }),
      row({ id: "m1", text: "ship it?", author_name: "Ana" }),
    ]);
    expect(chat[1]?.reply).toEqual({ author: "Ana", text: "ship it?" });
    expect(toChat([row({ reply_to: "gone" })])[0]?.reply).toBeNull();
  });

  test("shows a voice note's transcript as its text, and under a caption as a note", () => {
    expect(toChat([row({ derived_text: "transcript" })])[0]).toMatchObject({
      text: "transcript",
      note: null,
    });
    expect(
      toChat([row({ text: "caption", derived_text: "transcript" })])[0],
    ).toMatchObject({ text: "caption", note: "transcript" });
  });

  test("marks a withheld message so the skin says its content was withheld", () => {
    expect(toChat([row({ withheld: true })])[0]).toMatchObject({
      withheld: true,
      text: null,
    });
  });

  test("marks deleted and edited messages and keeps a call's offset", () => {
    const [m] = toChat([
      row({
        deleted_at: "2026-11-27T12:05:00.000Z",
        edited_at: "2026-11-27T12:02:00.000Z",
        offset_ms: 83_000,
      }),
    ]);
    expect(m).toMatchObject({ deleted: true, edited: true, offsetMs: 83_000 });
  });
});

describe("toMedia", () => {
  test("tells an attachment's kind by its type or mime and keeps its size", () => {
    expect(
      toMedia([
        { type: "image/jpeg", url: "https://x/y.jpg", size: 2048 },
        { type: "audio/ogg; codecs=opus" },
        { type: "sticker" },
        { name: "deck.pdf", type: "application/pdf" },
      ]),
    ).toEqual([
      {
        kind: "image",
        url: "https://x/y.jpg",
        name: null,
        bytes: 2048,
        durationS: null,
      },
      { kind: "audio", url: null, name: null, bytes: null, durationS: null },
      { kind: "sticker", url: null, name: null, bytes: null, durationS: null },
      {
        kind: "file",
        url: null,
        name: "deck.pdf",
        bytes: null,
        durationS: null,
      },
    ]);
  });

  test("reads no attachments as no media", () => {
    expect(toMedia(null)).toEqual([]);
  });
});
