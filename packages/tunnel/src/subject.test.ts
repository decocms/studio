import { expect, test } from "bun:test";

import {
  buildTunnelSubjects,
  decodeSubjectToken,
  encodeSubjectToken,
  parseTunnelUrl,
} from "./subject";

test("encodeSubjectToken encodes dotted hostnames into one safe token", () => {
  const token = encodeSubjectToken("user-abc.link");

  expect(token.length).toBeGreaterThan(0);
  expect(token).not.toContain(".");
  expect(token).not.toContain("*");
  expect(token).not.toContain(">");
  expect(token).not.toContain("=");
});

test("decodeSubjectToken reverses encodeSubjectToken", () => {
  const value = "user.with.dots@example.com";

  expect(decodeSubjectToken(encodeSubjectToken(value))).toBe(value);
});

test("decodeSubjectToken rejects malformed subject tokens clearly", () => {
  expect(() => decodeSubjectToken("not.valid")).toThrow("subject token");
});

test("buildTunnelSubjects scopes request subjects under encoded host", () => {
  const subjects = buildTunnelSubjects("user-abc.link", "req-1");
  const prefix = `tunnel.v1.host.${subjects.hostToken}`;

  expect(subjects.request).toBe(`${prefix}.request`);
  expect(subjects.body).toBe(`${prefix}.req.req-1.body`);
  expect(subjects.reply).toBe(`${prefix}.req.req-1.reply`);
  expect(subjects.abort).toBe(`${prefix}.req.req-1.abort`);
});

test("parseTunnelUrl rejects non-tunnel protocols", () => {
  expect(() => parseTunnelUrl("https://example.com")).toThrow(TypeError);
});

test("parseTunnelUrl preserves hostname and path with search", () => {
  const parsed = parseTunnelUrl("tunnel://user-abc.link/_sandbox/h/events?a=1");

  expect(parsed.url.protocol).toBe("tunnel:");
  expect(parsed.hostname).toBe("user-abc.link");
  expect(parsed.pathWithSearch).toBe("/_sandbox/h/events?a=1");
});

test("parseTunnelUrl rejects tunnel URLs with empty hostname", () => {
  expect(() => parseTunnelUrl("tunnel:/path")).toThrow("hostname");
});

test("buildTunnelSubjects rejects invalid request IDs", () => {
  expect(() => buildTunnelSubjects("user-abc.link", "req.1")).toThrow(
    "invalid requestId",
  );
});

test("buildTunnelSubjects rejects empty hostnames", () => {
  expect(() => buildTunnelSubjects("", "req-1")).toThrow("hostname");
});

test("buildTunnelSubjects rejects whitespace-only hostnames", () => {
  expect(() => buildTunnelSubjects(" ", "req-1")).toThrow("hostname");
});
