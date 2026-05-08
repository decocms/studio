import { describe, expect, it } from "bun:test";
import { parseBase64JsonBody } from "./body-parser";

function makeReq(raw: string): Request {
  return new Request("http://x/_decopilot_vm/bash", {
    method: "POST",
    body: raw,
    headers: { "Content-Type": "application/json" },
  });
}

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");
}

describe("parseBase64JsonBody", () => {
  it("decodes base64 JSON round-trip", async () => {
    const body = await parseBase64JsonBody(
      makeReq(b64({ command: "echo hi" })),
    );
    expect(body).toEqual({ command: "echo hi" });
  });

  it("handles UTF-8 content", async () => {
    const body = await parseBase64JsonBody(makeReq(b64({ s: "héllo—world" })));
    expect((body as { s: string }).s).toBe("héllo—world");
  });

  it("rejects invalid base64", async () => {
    await expect(
      parseBase64JsonBody(makeReq("not-valid-base64-!@#$")),
    ).rejects.toThrow(/Failed to parse body/);
  });

  it("rejects non-JSON decoded payload", async () => {
    const notJson = Buffer.from("plain text, not json", "utf-8").toString(
      "base64",
    );
    await expect(parseBase64JsonBody(makeReq(notJson))).rejects.toThrow(
      /Failed to parse body/,
    );
  });
});
