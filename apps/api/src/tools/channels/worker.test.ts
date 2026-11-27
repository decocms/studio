import { describe, expect, test } from "bun:test";
import { forwardedArguments, payloadOf, rpcMessageOf, scopeOf } from "./worker";

describe("rpcMessageOf", () => {
  test("reads a plain JSON answer", () => {
    expect(rpcMessageOf('{"jsonrpc":"2.0","id":1,"result":{"a":1}}')).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { a: 1 },
    } as never);
  });

  test("reads the answer out of SSE frames, past a notification before it", () => {
    const body = [
      "event: message",
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}',
      "",
      "",
    ].join("\n");
    expect(rpcMessageOf(body).result).toEqual({ tools: [] });
  });

  test("joins a message split over several data lines", () => {
    const body = 'data: {"id":1,\r\ndata: "error":{"message":"no"}}\r\n\r\n';
    expect(rpcMessageOf(body).error).toEqual({ message: "no" });
  });

  test("throws when no frame holds an answer, or the body isn't JSON", () => {
    expect(() => rpcMessageOf('data: {"method":"ping"}\n\n')).toThrow(
      "no answer",
    );
    expect(() => rpcMessageOf("<html>")).toThrow();
  });
});

describe("payloadOf", () => {
  test("prefers structured content", () => {
    expect(
      payloadOf({
        structuredContent: { sent: true },
        content: [{ type: "text", text: '{"other":1}' }],
      }),
    ).toEqual({ sent: true });
  });

  test("parses text as JSON, else returns it as text, else null", () => {
    expect(payloadOf({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual(
      { a: 1 },
    );
    expect(payloadOf({ content: [{ type: "text", text: "done" }] })).toBe(
      "done",
    );
    expect(payloadOf({})).toBeNull();
  });

  test("turns a worker error into a thrown error with the worker's text", () => {
    expect(() =>
      payloadOf({
        isError: true,
        content: [{ type: "text", text: "number not paired" }],
      }),
    ).toThrow("number not paired");
    expect(() => payloadOf({ isError: true })).toThrow("refused");
  });
});

describe("scopeOf", () => {
  test("sending and changing what was sent needs channels:send", () => {
    for (const tool of [
      "send_message",
      "update_message",
      "cancel_message",
      "list_outbox",
    ]) {
      expect(scopeOf(tool)).toBe("channels:send");
    }
  });

  test("every other worker tool needs connections:manage", () => {
    expect(scopeOf("pair_number")).toBe("connections:manage");
    expect(scopeOf("send_message_later")).toBe("connections:manage");
  });
});

describe("forwardedArguments", () => {
  test("drops every field only Studio writes and stamps the viewer", () => {
    const args = {
      chat: "c1",
      _viewer: "someone-else@example.com",
      _org: "o",
      _member: {},
      _owner: "x",
      _access: "admin",
    };
    expect(forwardedArguments(args, "me@example.com")).toEqual({
      chat: "c1",
      _viewer: "me@example.com",
    });
    expect(args._viewer).toBe("someone-else@example.com");
  });
});
