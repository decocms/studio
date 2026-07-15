import { describe, expect, it } from "bun:test";
import { RingBuffer } from "./ring-buffer";

// Regression coverage for #4522: TaskSummary.truncated silently stayed false
// after this buffer had already dropped bytes, because nothing pinned the
// drop-tracking invariant below. Any regression here re-hides real output
// loss from the tasks-list endpoint.
describe("RingBuffer", () => {
  it("keeps all data and reports no truncation while under capacity", () => {
    const buf = new RingBuffer(10);
    buf.append("ab");
    buf.append("cd");
    expect(buf.read()).toEqual({ data: "abcd", truncated: false });
    expect(buf.isTruncated()).toBe(false);
  });

  it("does not truncate when total size exactly equals capacity", () => {
    const buf = new RingBuffer(4);
    buf.append("ab");
    buf.append("cd");
    expect(buf.read()).toEqual({ data: "abcd", truncated: false });
  });

  it("keeps only the tail and flags truncated when a single append exceeds capacity", () => {
    const buf = new RingBuffer(5);
    buf.append("0123456789");
    expect(buf.read()).toEqual({ data: "56789", truncated: true });
  });

  it("drops whole oldest chunks then trims the next one, keeping exactly the tail", () => {
    const buf = new RingBuffer(5);
    buf.append("ab");
    buf.append("cd");
    buf.append("efgh");
    // Full stream was "abcdefgh" (8 chars); only the last 5 must survive.
    expect(buf.read()).toEqual({ data: "defgh", truncated: true });
  });

  it("ignores empty appends without affecting size or truncation state", () => {
    const buf = new RingBuffer(5);
    buf.append("abc");
    buf.append("");
    expect(buf.read()).toEqual({ data: "abc", truncated: false });
  });

  it("isTruncated stays true once data has been dropped, even after more appends", () => {
    const buf = new RingBuffer(3);
    buf.append("abcd");
    expect(buf.isTruncated()).toBe(true);
    buf.append("e");
    expect(buf.isTruncated()).toBe(true);
    expect(buf.read().data).toBe("cde");
  });
});
