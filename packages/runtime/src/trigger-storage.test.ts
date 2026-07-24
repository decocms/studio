import { describe, expect, it, spyOn } from "bun:test";
import { StudioKV } from "./trigger-storage.ts";

describe("StudioKV.get", () => {
  const kv = new StudioKV({ url: "https://studio.test", apiKey: "key" });

  it("returns null instead of throwing on an unparseable JSON body", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not json", { status: 200 }),
    );
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const state = await kv.get("conn_1");

    expect(state).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("returns null instead of trusting a malformed trigger state shape", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        value: { credentials: { callbackUrl: "https://x" } },
      }),
    );
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const state = await kv.get("conn_1");

    expect(state).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("returns the state when it matches the expected shape", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        value: {
          credentials: { callbackUrl: "https://x", callbackToken: "tok" },
          activeTriggerTypes: ["github.push"],
        },
      }),
    );

    const state = await kv.get("conn_1");

    expect(state).toEqual({
      credentials: { callbackUrl: "https://x", callbackToken: "tok" },
      activeTriggerTypes: ["github.push"],
    });
  });
});
