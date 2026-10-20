import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { TiptapProvider } from "./tiptap/input";
import { useWindowFileDrop } from "./input";
import type { AiProviderModel } from "@/hooks/collections/use-ai-providers.ts";

const fakeModel = {
  modelId: "m",
  capabilities: ["file"],
} as unknown as AiProviderModel;

function Probe() {
  useWindowFileDrop(fakeModel);
  return null;
}

function renderProbe(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <TiptapProvider tiptapDoc={undefined} setTiptapDoc={() => {}}>
        <Probe />
      </TiptapProvider>
    </QueryClientProvider>,
  ) as unknown as ReactNode;
}

describe("useWindowFileDrop", () => {
  it("does not read dataTransfer.files on a drop already handled by the editor's own file-drop plugin", () => {
    renderProbe();

    let filesAccessed = 0;
    const event = new DragEvent("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        get files() {
          filesAccessed++;
          return [];
        },
      },
    });
    event.preventDefault();

    window.dispatchEvent(event);

    expect(filesAccessed).toBe(0);
  });

  it("reads dataTransfer.files on a drop the editor did not already handle", () => {
    renderProbe();

    let filesAccessed = 0;
    const event = new DragEvent("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        get files() {
          filesAccessed++;
          return [];
        },
      },
    });

    window.dispatchEvent(event);

    expect(filesAccessed).toBe(1);
  });
});
