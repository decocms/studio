import { describe, expect, it } from "bun:test";
import {
  RELAY_BUFFER_MAX_BYTES,
  type RelayLine,
  relayLineSchema,
} from "./relay";

describe("relayLineSchema", () => {
  it("round-trips a ui-message-chunk line", () => {
    const line: RelayLine = {
      seq: 1,
      event: {
        type: "ui-message-chunk",
        chunk: { type: "text-delta", id: "t1", delta: "hello" },
      },
    };
    const parsed = relayLineSchema.parse(JSON.parse(JSON.stringify(line)));
    expect(parsed).toEqual(line);
  });

  it("round-trips an error line", () => {
    const line: RelayLine = {
      seq: 42,
      event: { type: "error", code: "harness_crashed", message: "boom" },
    };
    const parsed = relayLineSchema.parse(JSON.parse(JSON.stringify(line)));
    expect(parsed).toEqual(line);
  });

  it("round-trips a done line", () => {
    const line: RelayLine = { seq: 7, event: { type: "done" } };
    const parsed = relayLineSchema.parse(JSON.parse(JSON.stringify(line)));
    expect(parsed).toEqual(line);
  });

  it("rejects seq 0", () => {
    expect(
      relayLineSchema.safeParse({ seq: 0, event: { type: "done" } }).success,
    ).toBe(false);
  });

  it("rejects negative seq", () => {
    expect(
      relayLineSchema.safeParse({ seq: -3, event: { type: "done" } }).success,
    ).toBe(false);
  });

  it("rejects non-integer seq", () => {
    expect(
      relayLineSchema.safeParse({ seq: 1.5, event: { type: "done" } }).success,
    ).toBe(false);
  });

  it("rejects an unknown event type", () => {
    expect(
      relayLineSchema.safeParse({ seq: 1, event: { type: "nope" } }).success,
    ).toBe(false);
  });
});

describe("RELAY_BUFFER_MAX_BYTES", () => {
  it("is 64 MiB", () => {
    expect(RELAY_BUFFER_MAX_BYTES).toBe(64 * 1024 * 1024);
  });
});
