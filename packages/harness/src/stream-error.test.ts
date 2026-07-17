import { describe, expect, it } from "bun:test";
import {
  classifyStreamError,
  isCreditError,
  mcpConnectionErrorMessage,
  sanitizeStreamError,
} from "./stream-error";

describe("sanitizeStreamError", () => {
  it("strips provider URLs and branding from Error messages", () => {
    const err = new Error(
      "Model failed. See https://openrouter.ai/docs for details. Try again.",
    );
    const out = sanitizeStreamError(err);
    expect(out).not.toContain("openrouter");
    expect(out).not.toContain("https://");
  });

  it("extracts the message from non-Error gateway objects (no raw JSON)", () => {
    // The shape a 504 idle timeout arrives as — a plain object, not an Error.
    const err = {
      code: 504,
      message: "Upstream idle timeout exceeded",
      metadata: { error_type: "timeout" },
    };
    expect(sanitizeStreamError(err)).toBe("Upstream idle timeout exceeded.");
  });

  it("tags 402 plain objects as credit errors via numeric code", () => {
    const err = { code: 402, message: "Insufficient funds" };
    expect(sanitizeStreamError(err)).toContain("[CREDITS]");
  });

  it("detects credit errors from message text on plain objects", () => {
    const err = { message: "Your account has insufficient balance" };
    expect(sanitizeStreamError(err)).toContain("[CREDITS]");
  });

  it("falls back to JSON for opaque objects without a message", () => {
    expect(sanitizeStreamError({ foo: "bar" })).toContain("foo");
  });
});

describe("mcpConnectionErrorMessage", () => {
  const AUTH_RAW =
    'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Unauthorized: Authentication required"},"id":null}';

  it("maps a downstream 401 to a re-auth message", () => {
    expect(mcpConnectionErrorMessage(AUTH_RAW)).toMatch(/re-authenticated/i);
  });

  it("maps an open circuit breaker to a temporarily-unreachable message", () => {
    const raw =
      "Connection conn_l6eqXMhVzGPAYKHCdLRP0 circuit breaker is open — downstream server unreachable. Retry in 7s.";
    expect(mcpConnectionErrorMessage(raw)).toMatch(/temporarily unreachable/i);
  });

  it("maps a non-auth MCP transport failure to a generic reach message", () => {
    const raw =
      "Streamable HTTP error: Error POSTing to endpoint: 502 Bad Gateway";
    expect(mcpConnectionErrorMessage(raw)).toMatch(/couldn't reach/i);
  });

  it("does NOT map a model-provider auth failure (no MCP markers)", () => {
    expect(
      mcpConnectionErrorMessage("Incorrect API key provided. 401 Unauthorized"),
    ).toBeNull();
  });

  it("sanitizeStreamError returns the friendly text, never the raw -32000 blob", () => {
    const out = sanitizeStreamError(new Error(AUTH_RAW));
    expect(out).not.toContain("-32000");
    expect(out).not.toContain("jsonrpc");
    expect(out).toMatch(/re-authenticated/i);
  });
});

describe("isCreditError", () => {
  it("matches a 402 statusCode on an Error instance", () => {
    const err = Object.assign(new Error("Payment Required"), {
      statusCode: 402,
    });
    expect(isCreditError(err)).toBe(true);
  });

  it("matches a numeric 402 code on a plain gateway object", () => {
    expect(isCreditError({ code: 402, message: "boom" })).toBe(true);
  });

  it("matches credit/billing phrasing in the message", () => {
    expect(isCreditError(new Error("insufficient funds"))).toBe(true);
    expect(isCreditError({ message: "quota exceeded" })).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isCreditError(new Error("model is overloaded"))).toBe(false);
    expect(isCreditError({ code: 503, message: "service unavailable" })).toBe(
      false,
    );
  });
});

describe("classifyStreamError", () => {
  it("classifies a plain 504 idle-timeout object as timeout", () => {
    const err = {
      code: 504,
      message: "Upstream idle timeout exceeded",
      metadata: { error_type: "timeout" },
    };
    expect(classifyStreamError(err)).toBe("timeout");
  });
});
