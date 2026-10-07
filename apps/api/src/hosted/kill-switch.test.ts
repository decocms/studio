import { describe, expect, it } from "bun:test";
import { createKvRestDenylist } from "./denylist";
import { readKillState, setKilled } from "./kill-switch";

function fakeDenylist() {
  const keys = new Map<string, string>();
  return {
    keys,
    denylist: {
      get: async (key: string) => keys.get(key) ?? null,
      put: async (key: string) => {
        keys.set(key, "2026-10-07T00:00:00.000Z");
      },
      delete: async (key: string) => {
        keys.delete(key);
      },
    },
  };
}

describe("kill switch", () => {
  it("writes kill:<site> for every site of the org, and restore deletes them", async () => {
    const { keys, denylist } = fakeDenylist();
    const killed = await setKilled(denylist, ["a", "b", "a"], true);
    expect(killed).toEqual({
      killed: true,
      killedAt: "2026-10-07T00:00:00.000Z",
    });
    expect([...keys.keys()].sort()).toEqual(["kill:a", "kill:b"]);
    expect((await readKillState(denylist, ["b"])).killed).toBe(true);
    expect(await setKilled(denylist, ["a", "b"], false)).toEqual({
      killed: false,
      killedAt: null,
    });
    expect(keys.size).toBe(0);
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

  it("GET returns the value, or null for an absent key", async () => {
    const deny = createKvRestDenylist({
      accountId: "a",
      namespaceId: "n",
      apiToken: "t",
      fetch: (async (url: string) =>
        url.endsWith("kill%3Ax")
          ? new Response("2026-10-07T00:00:00.000Z")
          : new Response(null, { status: 404 })) as unknown as typeof fetch,
    });
    expect(await deny.get("kill:x")).toBe("2026-10-07T00:00:00.000Z");
    expect(await deny.get("kill:y")).toBeNull();
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
