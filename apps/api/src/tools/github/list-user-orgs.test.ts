import { describe, expect, it } from "bun:test";
import { parseInstallationsBody } from "./list-user-orgs";

describe("parseInstallationsBody", () => {
  it("parses a well-formed installations page", () => {
    expect(
      parseInstallationsBody(
        '{"installations":[{"id":1,"account":{"login":"acme","avatar_url":"u","type":"Organization"}}],"total_count":1}',
      ),
    ).toEqual({
      installations: [
        {
          id: 1,
          account: { login: "acme", avatar_url: "u", type: "Organization" },
        },
      ],
      total_count: 1,
    });
  });

  it("throws a named error instead of a raw SyntaxError on a malformed 2xx body", () => {
    expect(() => parseInstallationsBody("<html>upstream error</html>")).toThrow(
      /GitHub \/user\/installations returned invalid JSON: <html>upstream error<\/html>/,
    );
  });

  it("truncates a huge body so the message stays readable", () => {
    expect(() => parseInstallationsBody("x".repeat(5000))).toThrow(
      /invalid JSON: x{300}$/,
    );
  });
});
