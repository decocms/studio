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

  it("writes valid JSON under many concurrent set()/delete() calls", async () => {
    // Two writers only interleave ~75% of the time, so the case above let the
    // unserialized-`save()` race through as a flake. A wider fan-out makes the
    // corrupt-file regression deterministic instead of statistical.
    const dir = await mkdtemp(join(tmpdir(), "trigger-storage-"));
    const path = join(dir, "state.json");
    const storage = new JsonFileStorage({ path });
    const ids = Array.from({ length: 12 }, (_, i) => `conn-${i}`);

    try {
      await Promise.all(ids.map((id) => storage.set(id, state(id))));
      // Deletes share the same save() path — interleave them too.
      await Promise.all([
        ...ids.slice(0, 4).map((id) => storage.delete(id)),
        ...ids.slice(4).map((id) => storage.set(id, state(`${id}-v2`))),
      ]);

      const onDisk = JSON.parse(await readFile(path, "utf-8"));
      for (const id of ids.slice(0, 4)) {
        expect(onDisk[id]).toBeUndefined();
        expect(await storage.get(id)).toBeNull();
      }
      for (const id of ids.slice(4)) {
        expect(onDisk[id]).toEqual(state(`${id}-v2`));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
