import { describe, expect, it } from "bun:test";
import { parseJsonBody } from "./body-parser";

function makeReq(raw: string): Request {
  return new Request("http://x/_sandbox/bash", {
    method: "POST",
    body: raw,
    headers: { "Content-Type": "application/json" },
  });
}

describe("parseJsonBody", () => {
  it("decodes JSON body", async () => {
    const body = await parseJsonBody(
      makeReq(JSON.stringify({ command: "echo hi" })),
    );
    expect(body).toEqual({ command: "echo hi" });
  });

  it("handles UTF-8 content", async () => {
    const body = await parseJsonBody(
      makeReq(JSON.stringify({ s: "héllo—world" })),
    );
    expect((body as { s: string }).s).toBe("héllo—world");
  });

  it("rejects non-JSON payload", async () => {
    await expect(
      parseJsonBody(makeReq("plain text, not json")),
    ).rejects.toThrow(/Failed to parse body/);
  });
});
