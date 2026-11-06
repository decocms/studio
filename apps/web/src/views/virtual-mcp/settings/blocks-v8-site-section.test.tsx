import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import * as realCapability from "@/hooks/use-capability";
import * as realStudioTools from "@/lib/studio-tools";
import * as realSdk from "@/sdk";

const capabilityModule = { ...realCapability };
const studioToolsModule = { ...realStudioTools };
const sdkModule = { ...realSdk };
afterAll(() => {
  mock.module("@/hooks/use-capability", () => capabilityModule);
  mock.module("@/lib/studio-tools", () => studioToolsModule);
  mock.module("@/sdk", () => sdkModule);
});

const state = {
  isPrivileged: true,
  calls: [] as Array<{ name: string; args: unknown }>,
};
mock.module("@/hooks/use-capability", () => ({
  ...realCapability,
  useCapabilities: () => ({
    capabilities: {},
    loading: false,
    error: false,
    isPrivileged: state.isPrivileged,
    roleSlug: state.isPrivileged ? "admin" : "user",
  }),
}));
mock.module("@/lib/studio-tools", () => ({
  ...realStudioTools,
  useStudioTools: () => ({
    call: async (name: string, args: unknown) => {
      state.calls.push({ name, args });
      return { item: {} };
    },
  }),
}));
mock.module("@/sdk", () => ({
  ...realSdk,
  useProjectContext: () => ({ org: { id: "org_1", slug: "acme" } }),
}));

const { BlocksV8SiteSection } = await import("./blocks-v8-site-section");

const screen = () => within(document.body);

function renderSection(metadata: Record<string, unknown>) {
  const project = { id: "vir_1", metadata } as unknown as VirtualMCPEntity;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <BlocksV8SiteSection virtualMcp={project} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  state.isPrivileged = true;
  state.calls = [];
});

describe("BlocksV8SiteSection", () => {
  it("is hidden from a member who isn't an org owner or admin", () => {
    state.isPrivileged = false;
    renderSection({ blocksV8: true });
    expect(screen().queryByRole("switch")).toBeNull();
    expect(screen().queryByText("Blocks v8 site")).toBeNull();
  });

  it("shows an admin the switch off on a v7 site, and turns it on with blocksV8", async () => {
    renderSection({});
    const toggle = screen().getByRole("switch", { name: "Blocks v8 site" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.calls).toEqual([
      {
        name: "COLLECTION_VIRTUAL_MCP_UPDATE",
        args: { id: "vir_1", data: { blocksV8: true } },
      },
    ]);
  });

  it("shows it on for a v8 site, and turns it off (back to v7)", async () => {
    renderSection({ blocksV8: true });
    const toggle = screen().getByRole("switch", { name: "Blocks v8 site" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.calls).toEqual([
      {
        name: "COLLECTION_VIRTUAL_MCP_UPDATE",
        args: { id: "vir_1", data: { blocksV8: false } },
      },
    ]);
  });

  it("reads a stale v8 marker an earlier Studio wrote as off", () => {
    renderSection({ blocksMajor: 8 });
    expect(
      screen().getByRole("switch", { name: "Blocks v8 site" }),
    ).toHaveAttribute("aria-checked", "false");
  });
});
