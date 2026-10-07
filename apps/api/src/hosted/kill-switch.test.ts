import { describe, expect, it } from "bun:test";
import { createKvRestDenylist } from "./denylist";
import { memoryKv } from "./hosted-test-helpers";
import { readKillState, setKilled } from "./kill-switch";

function fakeDenylist() {
  const keys = new Set<string>();
  return {
    keys,
    denylist: {
      put: async (key: string) => {
        keys.add(key);
      },
      delete: async (key: string) => {
        keys.delete(key);
      },
    },
  };
}

describe("kill switch", () => {
  it("writes kill:<site> for every site of the org, and restore deletes them", async () => {
    const kv = memoryKv();
    const { keys, denylist } = fakeDenylist();
    const killed = await setKilled(
      { kv, denylist },
      "org",
      ["a", "b", "a"],
      true,
    );
    expect(killed.killed).toBe(true);
    expect([...keys].sort()).toEqual(["kill:a", "kill:b"]);
    expect((await readKillState(kv, "org")).killed).toBe(true);
    await setKilled({ kv, denylist }, "org", ["a", "b"], false);
    expect(keys.size).toBe(0);
    expect(await readKillState(kv, "org")).toEqual({
      killed: false,
      killedAt: null,
    });
  });
});

describe("createKvRestDenylist", () => {
  it("PUTs and DELETEs values through the Cloudflare KV REST API", async () => {
    const calls: Array<{ url: string; method: string; auth: string | null }> =
      [];
    const deny = createKvRestDenylist({
      accountId: "acct",
      namespaceId: "ns",
      apiToken: "tok",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({
          url,
          method: init.method ?? "GET",
          auth: new Headers(init.headers).get("authorization"),
        });
        return new Response(null, {
          status: init.method === "DELETE" ? 404 : 200,
        });
      }) as unknown as typeof fetch,
    });
    await deny.put("revoked:k/1");
    await deny.delete("kill:acme");
    expect(calls).toEqual([
      {
        url: "https://api.cloudflare.com/client/v4/accounts/acct/storage/kv/namespaces/ns/values/revoked%3Ak%2F1",
        method: "PUT",
        auth: "Bearer tok",
      },
      {
        url: "https://api.cloudflare.com/client/v4/accounts/acct/storage/kv/namespaces/ns/values/kill%3Aacme",
        method: "DELETE",
        auth: "Bearer tok",
      },
    ]);
  });

  it("throws when a write fails", async () => {
    const deny = createKvRestDenylist({
      accountId: "a",
      namespaceId: "n",
      apiToken: "t",
      fetch: (async () =>
        new Response(null, { status: 500 })) as unknown as typeof fetch,
    });
    await expect(deny.put("kill:x")).rejects.toThrow("HTTP 500");
  });
});
