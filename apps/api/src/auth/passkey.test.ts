import { describe, expect, it } from "bun:test";
import { createPasskeyConfig } from "./passkey";

describe("createPasskeyConfig", () => {
  it("binds the relying party to the base URL's hostname and origin", () => {
    expect(createPasskeyConfig("https://studio.example.com/")).toEqual({
      rpID: "studio.example.com",
      rpName: "deco Studio",
      origin: "https://studio.example.com",
    });
  });

  it("keeps a non-default port in the origin but not in the RP id", () => {
    const config = createPasskeyConfig("http://localhost:3100");
    expect(config.rpID).toBe("localhost");
    expect(config.origin).toBe("http://localhost:3100");
  });
});
