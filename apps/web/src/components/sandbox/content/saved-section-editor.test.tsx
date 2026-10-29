import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { afterAll, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as realBackend from "@/components/sections-editor/use-content-backend";
import * as realSdk from "@/sdk";
import * as realSaveBlock from "@/components/sections-editor/use-save-block";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";

const project = { backend: { kind: "protocol", source: "github" } as object };
const backendModule = { ...realBackend };
const sdkModule = { ...realSdk };
const saveBlockModule = { ...realSaveBlock };
afterAll(() => {
  mock.module(
    "@/components/sections-editor/use-content-backend",
    () => backendModule,
  );
  mock.module("@/sdk", () => sdkModule);
  mock.module(
    "@/components/sections-editor/use-save-block",
    () => saveBlockModule,
  );
});
mock.module("@/components/sections-editor/use-save-block", () => ({
  ...realSaveBlock,
  useDebouncedSaveBlock: () => ({
    save: () => {},
    flush: () => {},
    hold: () => {},
    isPending: false,
  }),
}));
mock.module("@/components/sections-editor/use-content-backend", () => ({
  ...realBackend,
  useContentBackend: () => project.backend,
}));
mock.module("@/sdk", () => ({
  ...realSdk,
  useVirtualMCPNonBlocking: () => null,
}));

const { SavedSectionEditor } = await import("./saved-section-editor");

const meta = { manifest: { blocks: {} }, schema: {} } as unknown as LiveMeta;

function renderEditor() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SavedSectionEditor
        orgSlug="acme"
        virtualMcpId="vm"
        branch="draft"
        previewUrl={null}
        meta={meta}
        decofile={{
          "spring-letter": {
            name: "Spring Letter I",
            __resolveType: "newsletter",
          },
        }}
        blockKey="spring-letter"
        onSaveReferencedBlock={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("SavedSectionEditor's header", () => {
  test("on a hosted v8 draft it names the section beside its dot", () => {
    project.backend = { kind: "protocol", source: "github" };
    const view = renderEditor();
    expect(view.getByTestId("saved-section-title").textContent).toBe(
      "Spring Letter I",
    );
    cleanup();
  });

  test("on any other backend it names the section too", () => {
    project.backend = { kind: "legacy" };
    const view = renderEditor();
    expect(view.getByTestId("saved-section-title").textContent).toBe(
      "Spring Letter I",
    );
    cleanup();
  });
});
