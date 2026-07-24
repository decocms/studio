import { describe, expect, test } from "bun:test";
import {
  readStudioHeader,
  STUDIO_HEADERS,
  writeStudioHeader,
} from "./studio-headers";

describe("Studio headers", () => {
  test("prefers the Studio header and accepts the legacy alias", () => {
    expect(
      readStudioHeader(
        new Headers({
          "x-studio-token": "current",
          "x-mesh-token": "legacy",
        }),
        "token",
      ),
    ).toBe("current");
    expect(
      readStudioHeader(new Headers({ "x-mesh-token": "legacy" }), "token"),
    ).toBe("legacy");
  });

  test("writes canonical and compatibility names", () => {
    const headers: Record<string, string> = {};
    writeStudioHeader(headers, "runMetadata", '{"source":"webhook"}');

    expect(headers[STUDIO_HEADERS.runMetadata]).toBe('{"source":"webhook"}');
    expect(headers["x-mesh-run-metadata"]).toBe('{"source":"webhook"}');
  });
});
