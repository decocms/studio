import { describe, expect, it } from "bun:test";
import { RetryError } from "@decocms/shared/std";
import {
  isGithubTransientServerError,
  parseGraphqlBody,
  unwrapGraphqlData,
  unwrapRetryError,
} from "./graphql";

const LABEL = "branch search for acme/site";

describe("parseGraphqlBody", () => {
  it("parses a well-formed JSON body", () => {
    expect(parseGraphqlBody('{"data":{"repository":null}}', LABEL)).toEqual({
      data: { repository: null },
    });
  });

  it("throws a named error instead of a raw SyntaxError on a malformed 2xx body", () => {
    expect(() =>
      parseGraphqlBody("<html>upstream error</html>", LABEL),
    ).toThrow(/acme\/site returned invalid JSON: <html>upstream error<\/html>/);
  });

  it("truncates a huge body so the message stays readable", () => {
    expect(() => parseGraphqlBody("x".repeat(5000), LABEL)).toThrow(
      /invalid JSON: x{300}$/,
    );
  });
});

describe("unwrapGraphqlData", () => {
  it("returns data when GitHub reported no errors", () => {
    expect(
      unwrapGraphqlData({ data: { repository: { id: 1 } } }, LABEL),
    ).toEqual({ repository: { id: 1 } });
  });

  /** A 200 carrying `errors` is the shape `res.ok` cannot catch. */
  it("throws on a GraphQL error rather than reporting an empty result", () => {
    expect(() =>
      unwrapGraphqlData(
        { errors: [{ message: "Resource not accessible by integration" }] },
        LABEL,
      ),
    ).toThrow(/Resource not accessible by integration/);
  });

  it("prefers the reported error over the missing-data message", () => {
    expect(() =>
      unwrapGraphqlData(
        { data: null, errors: [{ message: "Bad credentials" }] },
        LABEL,
      ),
    ).toThrow(/Bad credentials/);
  });

  it("throws when a 200 carried neither data nor errors", () => {
    expect(() => unwrapGraphqlData({}, LABEL)).toThrow(/returned no data/);
  });
});

describe("unwrapRetryError", () => {
  it("surfaces the wrapped cause on retry exhaustion", () => {
    const cause = new Error("GitHub GraphQL transient error: 503");
    expect(unwrapRetryError(new RetryError(cause, 3))).toBe(cause);
  });

  it("passes through a plain error unchanged", () => {
    const error = new Error("Connection is not a GitHub connection");
    expect(unwrapRetryError(error)).toBe(error);
  });
});

describe("isGithubTransientServerError", () => {
  it("flags 5xx as retriable outages", () => {
    expect(isGithubTransientServerError(500)).toBe(true);
    expect(isGithubTransientServerError(502)).toBe(true);
    expect(isGithubTransientServerError(503)).toBe(true);
  });

  it("does not flag a 4xx as transient", () => {
    expect(isGithubTransientServerError(401)).toBe(false);
    expect(isGithubTransientServerError(403)).toBe(false);
    expect(isGithubTransientServerError(404)).toBe(false);
    expect(isGithubTransientServerError(429)).toBe(false);
  });

  it("does not flag a 2xx as transient", () => {
    expect(isGithubTransientServerError(200)).toBe(false);
  });
});
