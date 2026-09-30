import { describe, expect, test } from "bun:test";
import type { SandboxProvider } from "./agent-sandbox";
import { type OwningSandboxProvider, SandboxProviderRouter } from "./router";
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
});
