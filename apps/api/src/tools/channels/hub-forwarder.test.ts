import { describe, expect, test } from "bun:test";
import {
  type HubConversation,
  type HubMessage,
  takeInOrder,
  toEvents,
} from "./hub-forwarder";

const conversation = (
  id: string,
  at: string,
  extra: Partial<HubConversation> = {},
): HubConversation => ({
  id: `whatsapp:${id}`,
  external_id: id,
  mirrored_at: at,
  kind: "group",
  title: null,
  parent_id: null,
  space: null,
  started_at: null,
  last_message_at: null,
  deleted_at: null,
  ...extra,
});

const message = (
  conv: string,
  id: string,
  at: string,
  extra: Partial<HubMessage> = {},
): HubMessage => ({
  id: `whatsapp:${conv}/${id}`,
  external_id: id,
  conversation_external_id: conv,
  mirrored_at: at,
  author_id: "whatsapp:p1",
  author_name: "Member One",
  ts: new Date("2026-11-01T10:00:00Z"),
  text: "hello",
  derived_text: null,
  kind: "text",
  reply_to: null,
  thread_id: null,
  attachments: null,
  offset_ms: null,
  duration_ms: null,
  edited_at: null,
  deleted_at: null,
  withheld: false,
  ...extra,
});

const T1 = "2026-11-01T10:00:00.000001Z";
const T2 = "2026-11-01T10:00:00.000002Z";

describe("takeInOrder", () => {
  test("merges both streams by (mirrored_at, id) and stops at the limit", () => {
    const convs = [conversation("c1", T1), conversation("c2", T2)];
    const msgs = [message("c1", "m1", T1), message("c1", "m2", T2)];
    const batch = takeInOrder(convs, msgs, 3);
    expect(batch.conversations.map((c) => c.external_id)).toEqual(["c1"]);
    expect(batch.messages.map((m) => m.external_id)).toEqual(["m1", "m2"]);
    expect(batch.cursor).toEqual({ at: T2, id: "whatsapp:c1/m2" });
  });

  test("has no cursor when there is nothing new", () => {
    expect(takeInOrder([], [], 10).cursor).toBeNull();
  });
});

describe("toEvents", () => {
  test("strips the hub's source prefix and keeps the ids at the source", () => {
    const events = toEvents("whatsapp", {
      conversations: [
        conversation("c1", T1, { parent_id: "whatsapp:parent", title: "Ops" }),
      ],
      messages: [message("c1", "m1", T1)],
      people: [
        { external_id: "p1", name: "Member One", email: null, phone: "+5500" },
      ],
    });
    expect(events).toEqual([
      {
        type: "conversation.upsert",
        conversation: expect.objectContaining({
          id: "c1",
          kind: "group",
          title: "Ops",
          parent_id: "parent",
        }),
      },
      {
        type: "person.upsert",
        person: {
          id: "p1",
          name: "Member One",
          email: undefined,
          phone: "+5500",
        },
      },
      {
        type: "message.upsert",
        message: expect.objectContaining({
          id: "m1",
          conversation_id: "c1",
          author_id: "p1",
          text: "hello",
          raw: { withheld: false },
        }),
      },
    ]);
  });

  test("a withheld message carries no content and says so", () => {
    const [event] = toEvents("whatsapp", {
      conversations: [],
      people: [],
      messages: [
        message("c1", "m1", T1, {
          withheld: true,
          derived_text: "transcript",
          attachments: [{ file_name: "a.jpg" }],
        }),
      ],
    });
    expect(event).toMatchObject({
      type: "message.upsert",
      message: {
        text: undefined,
        derived_text: undefined,
        attachments: undefined,
        raw: { withheld: true },
      },
    });
  });

  test("a deleted message is upserted, then deleted", () => {
    const deletedAt = new Date("2026-11-02T00:00:00Z");
    const events = toEvents("whatsapp", {
      conversations: [],
      people: [],
      messages: [message("c1", "m1", T1, { deleted_at: deletedAt })],
    });
    expect(events.map((e) => e.type)).toEqual([
      "message.upsert",
      "message.delete",
    ]);
    expect(events[1]).toEqual({
      type: "message.delete",
      message: { id: "m1", conversation_id: "c1", deleted_at: deletedAt },
    });
  });

  test("attachments keep the fields the ingest contract names, whatever the source called them", () => {
    const [event] = toEvents("discord", {
      conversations: [],
      people: [],
      messages: [
        message("c1", "m1", T1, {
          attachments: [
            { file_name: "a.ogg", mimetype: "audio/ogg", bytes: 10 },
            {
              filename: "b.png",
              content_type: "image/png",
              size: 5,
              url: "https://cdn.example/b.png",
            },
            "junk",
          ],
        }),
      ],
    });
    expect(
      event?.type === "message.upsert" && event.message.attachments,
    ).toEqual([
      { name: "a.ogg", type: "audio/ogg", size: 10, url: undefined },
      {
        name: "b.png",
        type: "image/png",
        size: 5,
        url: "https://cdn.example/b.png",
      },
    ]);
  });
});
