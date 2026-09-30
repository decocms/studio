import { describe, expect, test } from "bun:test";
import { sleep } from "@decocms/shared/std";
import { FreestyleApiError } from "freestyle";
import { ConfigRequestError } from "../daemon-client";
import type { SandboxProvider } from "./agent-sandbox";
import {
  handleShare,
  type OwningSandboxProvider,
  SandboxProviderRouter,
} from "./router";
import { sandboxProviderOfError } from "./shared/provider-tag";
import { computeHandle } from "./shared";
import type { EnsureOptions } from "./types";

const ID = { userId: "u1", projectRef: "agent:org:vmcp:feature-x" };
const HANDLE = computeHandle(ID);

async function kindOf(
  router: SandboxProviderRouter,
  handle: string,
  opts: EnsureOptions,
) {
  return (await router.place(handle, opts)).kind;
}

function fake(
  kind: string,
  state: {
    alive?: boolean;
    capacity?: boolean;
    owns?: boolean | Error;
    ensureError?: Error;
    available?: boolean;
    pools?: { tenant: string; image: string }[];
  } = {},
) {
  const calls: string[] = [];
  const provider = {
    calls,
    ensure: async () => {
      calls.push("ensure");
      if (state.ensureError) throw state.ensureError;
      return {
        handle: HANDLE,
        workdir: "/app",
        previewUrl: kind,
        warmPoolAdopted: false,
        provider: kind === "fs" ? "freestyle" : "kubernetes",
      };
    },
    alive: async () => state.alive ?? false,
    hasSchedulableCapacity: async () => state.capacity ?? true,
    owns: async () => {
      calls.push("owns");
      if (state.owns instanceof Error) throw state.owns;
      return state.owns ?? false;
    },
    available: () => state.available ?? true,
    listTenantPools: () => state.pools ?? [],
    delete: async () => {
      calls.push("delete");
    },
    getPreviewUrl: async () => kind,
    close: () => {},
  };
  return provider as unknown as OwningSandboxProvider & { calls: string[] };
}

describe("SandboxProviderRouter", () => {
  test("honors the requested provider for a new sandbox", async () => {
    const router = new SandboxProviderRouter({
      kubernetes: fake("k8s"),
      freestyle: fake("fs"),
    });
    const sb = await router.ensure(ID, { provider: "freestyle" });
    expect(sb.previewUrl).toBe("fs");
    // The pick sticks for handle-only calls.
    expect(await router.getPreviewUrl(HANDLE)).toBe("fs");
  });

  test("keeps an existing sandbox where it is", async () => {
    const router = new SandboxProviderRouter({
      kubernetes: fake("k8s", { alive: true }),
      freestyle: fake("fs"),
    });
    expect(await kindOf(router, HANDLE, { provider: "freestyle" })).toBe(
      "kubernetes",
    );
    const owned = new SandboxProviderRouter({
      kubernetes: fake("k8s"),
      freestyle: fake("fs", { owns: true }),
    });
    expect(await kindOf(owned, HANDLE, { provider: "kubernetes" })).toBe(
      "freestyle",
    );
    expect(await owned.getPreviewUrl(HANDLE)).toBe("fs");
  });

  test("falls back when the request cannot be served", async () => {
    const k8sOnly = new SandboxProviderRouter({ kubernetes: fake("k8s") });
    expect(await kindOf(k8sOnly, HANDLE, { provider: "freestyle" })).toBe(
      "kubernetes",
    );
    const fsOnly = new SandboxProviderRouter({ freestyle: fake("fs") });
    expect(await kindOf(fsOnly, HANDLE, { provider: "kubernetes" })).toBe(
      "freestyle",
    );
    const both = new SandboxProviderRouter({
      kubernetes: fake("k8s"),
      freestyle: fake("fs"),
    });
    expect(
      await kindOf(both, HANDLE, {
        provider: "freestyle",
        sandboxImage: "android",
      }),
    ).toBe("kubernetes");
    await expect(
      fsOnly.place(HANDLE, { sandboxImage: "android" }),
    ).rejects.toThrow("needs the kubernetes provider");
  });

  test("defaults to kubernetes while it has room, then freestyle", async () => {
    const roomy = new SandboxProviderRouter({
      kubernetes: fake("k8s"),
      freestyle: fake("fs"),
    });
    expect(await kindOf(roomy, HANDLE, {})).toBe("kubernetes");
    const full = new SandboxProviderRouter({
      kubernetes: fake("k8s", { capacity: false }),
      freestyle: fake("fs"),
    });
    expect(await kindOf(full, HANDLE, {})).toBe("freestyle");
    expect(await full.hasSchedulableCapacity()).toBe(true);
    const fullAlone = new SandboxProviderRouter({
      kubernetes: fake("k8s", { capacity: false }) as SandboxProvider,
    });
    expect(await fullAlone.hasSchedulableCapacity()).toBe(false);
  });

  test("splits new sandboxes by freestyleShare, the same way every time", async () => {
    const share = handleShare(HANDLE);
    const below = new SandboxProviderRouter(
      { kubernetes: fake("k8s"), freestyle: fake("fs") },
      { freestyleShare: Math.min(1, share + 0.01) },
    );
    expect(await kindOf(below, HANDLE, {})).toBe("freestyle");
    const above = new SandboxProviderRouter(
      { kubernetes: fake("k8s"), freestyle: fake("fs") },
      { freestyleShare: Math.max(0, share - 0.01) },
    );
    expect(await kindOf(above, HANDLE, {})).toBe("kubernetes");
    // An explicit request still wins over the split.
    expect(await kindOf(below, HANDLE, { provider: "kubernetes" })).toBe(
      "kubernetes",
    );
    // Roughly half of many handles fall under 0.5.
    const hits = Array.from({ length: 2_000 }, (_, i) =>
      handleShare(`h-${i}`),
    ).filter((x) => x < 0.5).length;
    expect(hits).toBeGreaterThan(900);
    expect(hits).toBeLessThan(1_100);
  });

  test("tags a failed ensure with the provider that ran it", async () => {
    const failing = fake("fs");
    failing.ensure = async () => {
      throw new ConfigRequestError(400, "bad config");
    };
    const router = new SandboxProviderRouter({
      kubernetes: fake("k8s"),
      freestyle: failing,
    });
    const err = await router
      .ensure(ID, { provider: "freestyle" })
      .catch((e: unknown) => e);
    expect(sandboxProviderOfError(err)).toBe("freestyle");
    expect(sandboxProviderOfError(new Error("rephrased", { cause: err }))).toBe(
      "freestyle",
    );
  });

  test("a Freestyle outage leaves Kubernetes sandboxes alone", async () => {
    const down = new Error("freestyle 503");
    const live = new SandboxProviderRouter({
      kubernetes: fake("k8s", { alive: true }),
      freestyle: fake("fs", { owns: down }),
    });
    expect(await live.getPreviewUrl(HANDLE)).toBe("k8s");
    expect(await live.place(HANDLE, {})).toEqual({
      kind: "kubernetes",
      reason: "existing",
    });
    const fresh = new SandboxProviderRouter(
      { kubernetes: fake("k8s"), freestyle: fake("fs", { owns: down }) },
      { freestyleShare: 1 },
    );
    expect(await fresh.place(HANDLE, { provider: "freestyle" })).toEqual({
      kind: "kubernetes",
      reason: "freestyle-unavailable",
    });
  });

  test("a live Kubernetes sandbox is placed without asking Freestyle", async () => {
    const freestyle = fake("fs");
    const router = new SandboxProviderRouter({
      kubernetes: fake("k8s", { alive: true }),
      freestyle,
    });
    await router.place(HANDLE, {});
    expect(freestyle.calls).not.toContain("owns");
  });

  test("places nothing new on an unavailable Freestyle", async () => {
    const router = new SandboxProviderRouter(
      { kubernetes: fake("k8s"), freestyle: fake("fs", { available: false }) },
      { freestyleShare: 1 },
    );
    expect(await router.place(HANDLE, {})).toEqual({
      kind: "kubernetes",
      reason: "freestyle-unavailable",
    });
  });

  test("keeps orgs with a tenant warm pool on Kubernetes", async () => {
    const router = new SandboxProviderRouter(
      {
        kubernetes: fake("k8s", {
          pools: [{ tenant: "org-1", image: "default" }],
        }),
        freestyle: fake("fs"),
      },
      { freestyleShare: 1 },
    );
    const tenant = { orgId: "org-1", userId: "u1" };
    expect(await router.place(HANDLE, { tenant })).toEqual({
      kind: "kubernetes",
      reason: "warm-pool",
    });
    expect(
      await kindOf(router, HANDLE, { tenant: { ...tenant, orgId: "org-2" } }),
    ).toBe("freestyle");
  });

  test("falls back to Kubernetes when Freestyle fails", async () => {
    const router = new SandboxProviderRouter({
      kubernetes: fake("k8s"),
      freestyle: fake("fs", {
        ensureError: new FreestyleApiError(429, { code: "RATE_LIMITED" }),
      }),
    });
    const sb = await router.ensure(ID, { provider: "freestyle" });
    expect(sb.provider).toBe("kubernetes");
    expect(sb.placement).toEqual({
      reason: "fallback",
      fallbackFrom: "freestyle",
    });
    expect(await router.getPreviewUrl(HANDLE)).toBe("k8s");
  });

  test("falls back to Freestyle when Kubernetes has no capacity", async () => {
    const router = new SandboxProviderRouter({
      kubernetes: fake("k8s", {
        ensureError: new Error("no capacity to schedule sandbox"),
      }),
      freestyle: fake("fs"),
    });
    const sb = await router.ensure(ID, {});
    expect(sb.provider).toBe("freestyle");
    expect(sb.placement?.fallbackFrom).toBe("kubernetes");
  });

  test("does not fall back on a config error", async () => {
    const freestyle = fake("fs");
    const router = new SandboxProviderRouter({
      kubernetes: fake("k8s", {
        ensureError: new ConfigRequestError(409, "conflict"),
      }),
      freestyle,
    });
    await expect(router.ensure(ID, {})).rejects.toBeInstanceOf(
      ConfigRequestError,
    );
    expect(freestyle.calls).not.toContain("ensure");
  });

  test("a resume that falls back deletes the old sandbox", async () => {
    const freestyle = fake("fs", {
      owns: true,
      ensureError: new FreestyleApiError(503, { code: "UNAVAILABLE" }),
    });
    const router = new SandboxProviderRouter({
      kubernetes: fake("k8s"),
      freestyle,
    });
    const sb = await router.ensure(ID, {});
    expect(sb.provider).toBe("kubernetes");
    await sleep(0);
    expect(freestyle.calls).toContain("delete");
  });

  test("Android never goes to Freestyle, even on failure", async () => {
    const freestyle = fake("fs");
    const router = new SandboxProviderRouter({
      kubernetes: fake("k8s", { ensureError: new Error("claim bind failed") }),
      freestyle,
    });
    await expect(
      router.ensure(ID, { sandboxImage: "android" }),
    ).rejects.toThrow("claim bind failed");
    expect(freestyle.calls).not.toContain("ensure");
  });

  test("a live copy left behind by a fallback does not win the next place", async () => {
    const kubernetes = fake("k8s", {
      alive: true,
      ensureError: new Error("claim bind failed"),
    });
    kubernetes.delete = async () => {
      kubernetes.calls.push("delete");
      throw new Error("kube api down");
    };
    const router = new SandboxProviderRouter({
      kubernetes,
      freestyle: fake("fs", { owns: true }),
    });
    expect((await router.ensure(ID, {})).provider).toBe("freestyle");
    expect(await router.place(HANDLE, {})).toEqual({
      kind: "freestyle",
      reason: "existing",
    });
    expect(kubernetes.calls).toContain("delete");
  });
});
