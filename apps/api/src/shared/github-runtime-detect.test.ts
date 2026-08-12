import { describe, it, expect } from "bun:test";
import { extractDevPort } from "./github-runtime-detect";

describe("extractDevPort", () => {
  it("extracts a valid port from a dev script", () => {
    expect(
      extractDevPort(
        JSON.stringify({ scripts: { dev: "PORT=3000 next dev" } }),
      ),
    ).toBe("3000");
  });

  it("extracts a valid port from a deno task", () => {
    expect(
      extractDevPort(JSON.stringify({ tasks: { dev: "deno run --port8000" } })),
    ).toBe("8000");
  });

  it("drops an out-of-range 5-digit match instead of returning it", () => {
    expect(
      extractDevPort(
        JSON.stringify({ scripts: { dev: "PORT=99999 next dev" } }),
      ),
    ).toBeNull();
  });

  it("returns null when the script has no port", () => {
    expect(
      extractDevPort(JSON.stringify({ scripts: { dev: "next dev" } })),
    ).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(extractDevPort("not json")).toBeNull();
  });

  it("returns null for null content", () => {
    expect(extractDevPort(null)).toBeNull();
  });
});
