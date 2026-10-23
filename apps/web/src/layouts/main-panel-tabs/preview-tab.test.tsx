import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";

const APP = "http://localhost:3000/";
const refs = {
  backend: { kind: "pending" } as Record<string, unknown>,
  connection: null as { endpoint: string } | null,
  reachable: null as boolean | null,
  probedUrl: undefined as string | null | undefined,
  access: "granted" as "granted" | "denied",
};

mock.module("@/components/sandbox/preview/preview", () => ({
  PreviewContent: () => <div data-testid="preview-frame" />,
}));
mock.module("@/components/sandbox/preview/multi-app-preview", () => ({
  ProjectMultiAppPreview: ({ children }: { children: ReactNode }) => children,
}));
mock.module("@/hooks/use-organization-settings", () => ({
  useOrgFlag: () => false,
}));
mock.module("@/hooks/use-new-blocks-editor", () => ({
  NewBlocksEditorProvider: ({ children }: { children: ReactNode }) => children,
}));
mock.module("@/components/chat/chat-context", () => ({
  useChatTask: () => ({
    activeTask: null,
    taskId: "t1",
    currentBranch: "main",
  }),
  useOptionalChatTask: () => null,
}));
mock.module("@/components/repository-import-picker", () => ({
  RepositoryImportPicker: () => null,
}));
mock.module("./use-task-metadata", () => ({ useTaskMetadata: () => null }));
mock.module("@/sdk", () => ({
  useVirtualMCP: () => ({ id: "vmcp", metadata: { blocksMajor: 8 } }),
}));
mock.module("@/lib/agent-capabilities", () => ({
  agentHasClonableSource: () => true,
}));
mock.module("@/hooks/use-deco-serve-connection", () => ({
  useDecoServeConnection: () => ({ connection: refs.connection }),
}));
mock.module("@/components/sections-editor/use-content-backend", () => ({
  useContentBackend: () => refs.backend,
}));
mock.module("@/hooks/use-local-app-reachable", () => ({
  useLocalAppReachable: (url: string | null) => {
    refs.probedUrl = url;
    return url ? refs.reachable : null;
  },
}));

mock.module("@/hooks/use-deco-serve-discovery", () => ({
  useLocalNetworkAccess: () => refs.access,
}));

const { PreviewTab } = await import("./preview-tab");

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = () =>
  renderBare(<PreviewTab virtualMcpId="vmcp" />, { wrapper });

const connectedWithApp = {
  kind: "protocol",
  source: "local",
  describe: { preview: { url: APP } },
};

describe("PreviewTab with Localhost: waits for the app", () => {
  beforeEach(() => {
    refs.backend = { kind: "pending" };
    refs.connection = { endpoint: "http://localhost:4545/rpc" };
    refs.reachable = null;
    refs.probedUrl = undefined;
  });

  it("app not answering yet: the 'Waiting for your app' guide, no frame", () => {
    refs.backend = connectedWithApp;
    refs.reachable = false;
    const { getByText, queryByTestId } = render();
    expect(refs.probedUrl).toBe(APP);
    expect(getByText("Waiting for your app")).toBeInTheDocument();
    // The address is inline <code> inside the one sentence, which points to
    // the Content tab for editing meanwhile.
    const address = getByText("localhost:3000");
    expect(address.tagName).toBe("CODE");
    expect(address.parentElement?.textContent).toBe(
      "Your app at localhost:3000 isn't answering yet. If it isn't running, start it on your computer. Meanwhile, you can edit your content in the Content tab.",
    );
    expect(
      getByText("The preview loads on its own as soon as your app answers."),
    ).toBeInTheDocument();
    expect(queryByTestId("preview-frame")).not.toBeInTheDocument();
  });

  it("first check still running: the guide, not a blank frame", () => {
    refs.backend = connectedWithApp;
    refs.reachable = null;
    const { getByText, queryByTestId } = render();
    expect(getByText("Waiting for your app")).toBeInTheDocument();
    expect(queryByTestId("preview-frame")).not.toBeInTheDocument();
  });

  it("app answering: the frame (mounted fresh, so it loads the app)", () => {
    refs.backend = connectedWithApp;
    refs.reachable = true;
    const { queryByText, getByTestId } = render();
    expect(getByTestId("preview-frame")).toBeInTheDocument();
    expect(queryByText("Waiting for your app")).not.toBeInTheDocument();
  });

  it("app gone, then back: guide, then the frame again", () => {
    refs.backend = connectedWithApp;
    refs.reachable = true;
    const view = render();
    expect(view.getByTestId("preview-frame")).toBeInTheDocument();
    refs.reachable = false;
    view.rerender(<PreviewTab virtualMcpId="vmcp" />);
    expect(view.getByText("Waiting for your app")).toBeInTheDocument();
    expect(view.queryByTestId("preview-frame")).not.toBeInTheDocument();
    refs.reachable = true;
    view.rerender(<PreviewTab virtualMcpId="vmcp" />);
    expect(view.getByTestId("preview-frame")).toBeInTheDocument();
  });

  it("no Localhost: nothing is probed, the usual preview", () => {
    refs.connection = null;
    refs.backend = { kind: "legacy" };
    const { getByTestId } = render();
    expect(refs.probedUrl).toBeNull();
    expect(getByTestId("preview-frame")).toBeInTheDocument();
  });
});

describe("PreviewTab with Localhost: the empty state while it connects", () => {
  beforeEach(() => {
    refs.connection = { endpoint: "http://localhost:4545/rpc" };
    refs.reachable = null;
    refs.access = "granted";
  });
  const wire = (view: ReturnType<typeof render>) =>
    view.getByTestId("connection-wire").dataset.waiting;

  it("connecting: the guide with the command, looking, the dot travelling", () => {
    refs.backend = { kind: "pending" };
    const view = render();
    expect(
      view.getByRole("heading", {
        level: 2,
        name: "Waiting for your computer",
      }),
    ).toBeInTheDocument();
    expect(
      view.getByRole("button", { name: "Copy command" }),
    ).toBeInTheDocument();
    expect(
      view.getByText("Looking for deco serve on localhost:4545…"),
    ).toBeInTheDocument();
    expect(wire(view)).toBe("true");
    expect(view.queryByTestId("preview-frame")).not.toBeInTheDocument();
  });

  it("nothing answering: keeps looking, the dot travelling", () => {
    refs.backend = { kind: "unavailable", source: "local" };
    const view = render();
    expect(
      view.getByText("Looking for deco serve on localhost:4545…"),
    ).toBeInTheDocument();
    expect(wire(view)).toBe("true");
  });

  it("Chrome blocking: says how to allow it, the dot still", () => {
    refs.backend = { kind: "unavailable", source: "local" };
    refs.access = "denied";
    const view = render();
    expect(
      view.getByText("Chrome is blocking Studio from reaching your computer"),
    ).toBeInTheDocument();
    expect(wire(view)).toBe("false");
  });

  it("a server that can't be used: what it is and the next step (was the header pill)", () => {
    refs.backend = {
      kind: "unavailable",
      source: "local",
      problem: { reason: "not-deco-serve" },
    };
    const view = render();
    expect(
      view.getByRole("heading", {
        level: 2,
        name: "Another program is using localhost:4545",
      }),
    ).toBeInTheDocument();
    expect(wire(view)).toBe("false");
  });

  it("connected with no app: how to name it, with the command", () => {
    refs.backend = { kind: "protocol", source: "local", describe: {} };
    const view = render();
    expect(
      view.getByText("Start your app to see the preview"),
    ).toBeInTheDocument();
    expect(
      view.getByText("localhost:3000", { selector: "span" }),
    ).toBeInTheDocument();
    expect(wire(view)).toBe("false");
  });

  it("waiting for the app: the same empty state, the dot travelling", () => {
    refs.backend = connectedWithApp;
    refs.reachable = false;
    const view = render();
    expect(wire(view)).toBe("true");
  });
});
