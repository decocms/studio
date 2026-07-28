import { describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileStorage, StudioKV } from "./trigger-storage.ts";

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

describe("JsonFileStorage", () => {
  const state = (token: string) => ({
    credentials: { callbackUrl: "https://x", callbackToken: token },
    activeTriggerTypes: ["github.push"],
  });

  it("keeps both writes when set() is called concurrently before the first load resolves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trigger-storage-"));
    const path = join(dir, "state.json");
    const storage = new JsonFileStorage({ path });

    try {
      await Promise.all([
        storage.set("conn-a", state("token-a")),
        storage.set("conn-b", state("token-b")),
      ]);

      expect(await storage.get("conn-a")).toEqual(state("token-a"));
      expect(await storage.get("conn-b")).toEqual(state("token-b"));

      const onDisk = JSON.parse(await readFile(path, "utf-8"));
      expect(onDisk["conn-a"]).toEqual(state("token-a"));
      expect(onDisk["conn-b"]).toEqual(state("token-b"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps every write when set() is called concurrently after the cache is warm", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trigger-storage-"));
    const path = join(dir, "state.json");
    const storage = new JsonFileStorage({ path });

    try {
      // Warm the cache first so subsequent set() calls skip load() entirely
      // and race only on the overlapping fs.writeFile calls inside save().
      await storage.set("conn-a", state("token-a"));

      await Promise.all([
        storage.set("conn-b", state("token-b")),
        storage.set("conn-c", state("token-c")),
        storage.set("conn-d", state("token-d")),
      ]);

      const onDisk = JSON.parse(await readFile(path, "utf-8"));
      expect(onDisk["conn-a"]).toEqual(state("token-a"));
      expect(onDisk["conn-b"]).toEqual(state("token-b"));
      expect(onDisk["conn-c"]).toEqual(state("token-c"));
      expect(onDisk["conn-d"]).toEqual(state("token-d"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
