import { expect, test } from "bun:test";

import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  type ResponseFrame,
} from "./protocol";

test("round-trips a response.start frame", () => {
  const frame = {
    type: "response.start",
    requestId: "req-1",
    status: 200,
    statusText: "OK",
    headers: [["content-type", "application/json"]],
  } satisfies ResponseFrame;

  expect(decodeTunnelFrame(encodeTunnelFrame(frame))).toEqual(frame);
});

test("decodeTunnelFrame rejects object response headers", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      type: "response.start",
      requestId: "req-1",
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  expect(() => decodeTunnelFrame(bytes)).toThrow("headers");
});

test("decodeTunnelFrame rejects unsafe request IDs", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      type: "response.start",
      requestId: "req.1",
      status: 200,
      headers: [],
    }),
  );

  expect(() => decodeTunnelFrame(bytes)).toThrow("requestId");
});

test("decodeTunnelFrame rejects unknown frame types clearly", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ type: "response.mystery", requestId: "req-1" }),
  );

  expect(() => decodeTunnelFrame(bytes)).toThrow("unknown frame type");
});

test("decodeTunnelFrame validates response status range", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      type: "response.start",
      requestId: "req-1",
      status: 99,
      headers: [],
    }),
  );

  expect(() => decodeTunnelFrame(bytes)).toThrow();
});

test("decodeTunnelFrame rejects malformed JSON clearly", () => {
  const bytes = new TextEncoder().encode("{");

  expect(() => decodeTunnelFrame(bytes)).toThrow("malformed JSON");
});

test("decodeTunnelFrame rejects frames with missing type clearly", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ requestId: "req-1" }),
  );

  expect(() => decodeTunnelFrame(bytes)).toThrow("frame type missing");
});
