import { describe, expect, test } from "bun:test";
import type { SandboxProvider } from "./agent-sandbox";
import {
  handleShare,
  type OwningSandboxProvider,
  SandboxProviderRouter,
} from "./router";
import { sandboxProviderOfError } from "./shared/provider-tag";
import { computeHandle } from "./shared";

const ID = { userId: "u1", projectRef: "agent:org:vmcp:feature-x" };
const HANDLE = computeHandle(ID);

function fake(
  kind: string,
  state: { alive?: boolean; capacity?: boolean; owns?: boolean } = {},
) {
  const calls: string[] = [];
  const provider = {
    calls,
    ensure: async () => {
      calls.push("ensure");
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
    owns: async () => state.owns ?? false,
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
    expect(await router.place(HANDLE, { provider: "freestyle" })).toBe(
      "kubernetes",
    );
    const owned = new SandboxProviderRouter({
      kubernetes: fake("k8s"),
      freestyle: fake("fs", { owns: true }),
    });
    expect(await owned.place(HANDLE, { provider: "kubernetes" })).toBe(
      "freestyle",
    );
    expect(await owned.getPreviewUrl(HANDLE)).toBe("fs");
  });

  test("falls back when the request cannot be served", async () => {
    const k8sOnly = new SandboxProviderRouter({ kubernetes: fake("k8s") });
    expect(await k8sOnly.place(HANDLE, { provider: "freestyle" })).toBe(
      "kubernetes",
    );
    const fsOnly = new SandboxProviderRouter({ freestyle: fake("fs") });
    expect(await fsOnly.place(HANDLE, { provider: "kubernetes" })).toBe(
      "freestyle",
    );
    const both = new SandboxProviderRouter({
      kubernetes: fake("k8s"),
      freestyle: fake("fs"),
    });
    expect(
      await both.place(HANDLE, {
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
    expect(await roomy.place(HANDLE, {})).toBe("kubernetes");
    const full = new SandboxProviderRouter({
      kubernetes: fake("k8s", { capacity: false }),
      freestyle: fake("fs"),
    });
    expect(await full.place(HANDLE, {})).toBe("freestyle");
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
    expect(await below.place(HANDLE, {})).toBe("freestyle");
    const above = new SandboxProviderRouter(
      { kubernetes: fake("k8s"), freestyle: fake("fs") },
      { freestyleShare: Math.max(0, share - 0.01) },
    );
    expect(await above.place(HANDLE, {})).toBe("kubernetes");
    // An explicit request still wins over the split.
    expect(await below.place(HANDLE, { provider: "kubernetes" })).toBe(
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
      throw new Error("vm boot failed");
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
});
