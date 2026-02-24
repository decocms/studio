/// <reference lib="dom" />
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import type { SlotResolution } from "./use-slot-resolution";
import type { ConnectionPollerResult } from "./use-connection-poller";

// ── Module mocks (hoisted by Bun before imports) ─────────────────────────────

const mockUseSlotResolution = mock(() => makeResolution());
const mockUseConnectionPoller = mock(() => makePoller());
const mockIsConnectionAuthenticated = mock(() =>
  Promise.resolve({ supportsOAuth: false }),
);

mock.module("./use-slot-resolution", () => ({
  useSlotResolution: mockUseSlotResolution,
}));

mock.module("./use-connection-poller", () => ({
  useConnectionPoller: mockUseConnectionPoller,
}));

mock.module("@decocms/mesh-sdk", () => ({
  isConnectionAuthenticated: mockIsConnectionAuthenticated,
}));

// Stub child components — expose only what SlotCard passes to them
mock.module("./slot-install-form", () => ({
  SlotInstallForm: ({ onInstalled }: { onInstalled: (id: string) => void }) =>
    React.createElement(
      "button",
      { "data-testid": "install-btn", onClick: () => onInstalled("conn_new") },
      "Install",
    ),
}));

mock.module("./slot-done", () => ({
  SlotDone: ({
    label,
    connection,
    onReset,
  }: {
    label: string;
    connection: ConnectionEntity;
    onReset: () => void;
  }) =>
    React.createElement(
      "div",
      { "data-testid": "slot-done" },
      React.createElement("span", { "data-testid": "done-label" }, label),
      React.createElement(
        "span",
        { "data-testid": "done-connection" },
        connection.title,
      ),
      React.createElement(
        "button",
        { "data-testid": "change-btn", onClick: onReset },
        "Change",
      ),
    ),
}));

mock.module("./slot-auth-oauth", () => ({
  SlotAuthOAuth: ({
    connectionId,
    onAuthed,
  }: {
    connectionId: string;
    onAuthed: () => void;
  }) =>
    React.createElement(
      "button",
      {
        "data-testid": "oauth-btn",
        "data-connection-id": connectionId,
        onClick: onAuthed,
      },
      "Authorize",
    ),
}));

mock.module("./slot-auth-token", () => ({
  SlotAuthToken: ({
    connectionId,
    onAuthed,
  }: {
    connectionId: string;
    onAuthed: () => void;
  }) =>
    React.createElement(
      "button",
      {
        "data-testid": "token-btn",
        "data-connection-id": connectionId,
        onClick: onAuthed,
      },
      "Submit Token",
    ),
}));

// ── Import component after mocks ─────────────────────────────────────────────

// Bun hoists mock.module calls, so static import gets the mocked dependencies
import { SlotCard } from "./slot-card";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConn(
  overrides: Partial<ConnectionEntity> & {
    metadata?: Record<string, unknown>;
  } = {},
): ConnectionEntity {
  return {
    id: "conn_test",
    title: "Test Connection",
    status: "active",
    connection_type: "HTTP",
    connection_url: null,
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    description: null,
    icon: null,
    app_name: null,
    app_id: null,
    tools: null,
    bindings: null,
    organization_id: "org_1",
    created_by: "user_1",
    updated_by: "user_1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as unknown as ConnectionEntity;
}

function makeResolution(
  overrides: Partial<SlotResolution> = {},
): SlotResolution {
  return {
    initialPhase: "install",
    registryItem: {
      id: "item_1",
      title: "Test MCP",
      server: { name: "deco/test" },
      created_at: "",
      updated_at: "",
    } as SlotResolution["registryItem"],
    matchingConnections: [],
    satisfiedConnection: null,
    isLoading: false,
    registryError: null,
    ...overrides,
  };
}

function makePoller(
  overrides: Partial<ConnectionPollerResult> = {},
): ConnectionPollerResult {
  return {
    connection: null,
    isActive: false,
    isTimedOut: false,
    isPolling: false,
    ...overrides,
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

const slot = {
  label: "Test MCP",
  registry: "deco-registry",
  item_id: "deco/test",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockUseSlotResolution.mockReset();
  mockUseConnectionPoller.mockReset();
  mockIsConnectionAuthenticated.mockReset();
  mockIsConnectionAuthenticated.mockReturnValue(
    Promise.resolve({ supportsOAuth: false }),
  );
});

describe("SlotCard", () => {
  describe("loading state", () => {
    it("shows slot label and no form while registry item loads", () => {
      mockUseSlotResolution.mockReturnValue(
        makeResolution({ initialPhase: "loading", isLoading: true }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      render(React.createElement(SlotCard, { slot, onComplete: () => {} }), {
        wrapper: createWrapper(),
      });

      expect(screen.getByText("Test MCP")).toBeInTheDocument();
      expect(screen.queryByTestId("install-btn")).toBeNull();
      expect(screen.queryByTestId("slot-done")).toBeNull();
    });
  });

  describe("registry error state", () => {
    it("shows the error message when the registry item is not found", () => {
      mockUseSlotResolution.mockReturnValue(
        makeResolution({ registryError: "Registry item not found." }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      render(React.createElement(SlotCard, { slot, onComplete: () => {} }), {
        wrapper: createWrapper(),
      });

      expect(screen.getByText("Registry item not found.")).toBeInTheDocument();
      expect(screen.queryByTestId("install-btn")).toBeNull();
    });
  });

  describe("install phase", () => {
    it("renders the install form when no existing connections", () => {
      mockUseSlotResolution.mockReturnValue(
        makeResolution({ initialPhase: "install" }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      render(React.createElement(SlotCard, { slot, onComplete: () => {} }), {
        wrapper: createWrapper(),
      });

      expect(screen.getByTestId("install-btn")).toBeInTheDocument();
    });

    it("transitions to polling when the install form submits", () => {
      mockUseSlotResolution.mockReturnValue(
        makeResolution({ initialPhase: "install" }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      render(React.createElement(SlotCard, { slot, onComplete: () => {} }), {
        wrapper: createWrapper(),
      });

      fireEvent.click(screen.getByTestId("install-btn"));

      expect(screen.getByText("Connecting...")).toBeInTheDocument();
      expect(screen.queryByTestId("install-btn")).toBeNull();
    });
  });

  describe("polling phase", () => {
    it("shows Connecting... spinner while polling", () => {
      mockUseSlotResolution.mockReturnValue(
        makeResolution({ initialPhase: "install" }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller({ isPolling: true }));

      render(React.createElement(SlotCard, { slot, onComplete: () => {} }), {
        wrapper: createWrapper(),
      });
      fireEvent.click(screen.getByTestId("install-btn"));

      expect(screen.getByText("Connecting...")).toBeInTheDocument();
    });

    it("transitions to done and calls onComplete when the connection becomes active", () => {
      const conn = makeConn({
        id: "conn_abc",
        title: "OpenRouter",
        status: "active",
      });
      const onComplete = mock(() => {});

      mockUseSlotResolution.mockReturnValue(
        makeResolution({ initialPhase: "install" }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      const { rerender } = render(
        React.createElement(SlotCard, { slot, onComplete }),
        { wrapper: createWrapper() },
      );
      fireEvent.click(screen.getByTestId("install-btn"));

      mockUseConnectionPoller.mockReturnValue(
        makePoller({ isActive: true, connection: conn }),
      );
      rerender(React.createElement(SlotCard, { slot, onComplete }));

      expect(screen.getByTestId("done-connection")).toHaveTextContent(
        "OpenRouter",
      );
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith("conn_abc");
    });

    it("only calls onComplete once across multiple re-renders with the same active connection", () => {
      const conn = makeConn({ id: "conn_abc", status: "active" });
      const onComplete = mock(() => {});

      mockUseSlotResolution.mockReturnValue(
        makeResolution({ initialPhase: "install" }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      const { rerender } = render(
        React.createElement(SlotCard, { slot, onComplete }),
        { wrapper: createWrapper() },
      );
      // Click install to set pollingConnectionId, then poller goes active
      fireEvent.click(screen.getByTestId("install-btn"));

      mockUseConnectionPoller.mockReturnValue(
        makePoller({ isActive: true, connection: conn }),
      );
      rerender(React.createElement(SlotCard, { slot, onComplete }));
      rerender(React.createElement(SlotCard, { slot, onComplete }));
      rerender(React.createElement(SlotCard, { slot, onComplete }));

      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe("auth-oauth phase", () => {
    it("shows OAuth button when polling times out and endpoint supports OAuth", async () => {
      const conn = makeConn({ id: "conn_auth", status: "inactive" });
      mockIsConnectionAuthenticated.mockResolvedValue({ supportsOAuth: true });

      mockUseSlotResolution.mockReturnValue(
        makeResolution({ initialPhase: "install" }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      const { rerender } = render(
        React.createElement(SlotCard, { slot, onComplete: () => {} }),
        { wrapper: createWrapper() },
      );
      fireEvent.click(screen.getByTestId("install-btn"));

      mockUseConnectionPoller.mockReturnValue(
        makePoller({ isTimedOut: true, connection: conn }),
      );
      rerender(React.createElement(SlotCard, { slot, onComplete: () => {} }));

      await waitFor(() =>
        expect(screen.getByTestId("oauth-btn")).toBeInTheDocument(),
      );
    });

    it("shows OAuth button even when the poller never fetched a connection entity (null connection fix)", async () => {
      mockIsConnectionAuthenticated.mockResolvedValue({ supportsOAuth: true });

      mockUseSlotResolution.mockReturnValue(
        makeResolution({ initialPhase: "install" }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      const { rerender } = render(
        React.createElement(SlotCard, { slot, onComplete: () => {} }),
        { wrapper: createWrapper() },
      );
      fireEvent.click(screen.getByTestId("install-btn"));

      // connection is null — this was the "stuck state" bug
      mockUseConnectionPoller.mockReturnValue(
        makePoller({ isTimedOut: true, connection: null }),
      );
      rerender(React.createElement(SlotCard, { slot, onComplete: () => {} }));

      await waitFor(() =>
        expect(screen.getByTestId("oauth-btn")).toBeInTheDocument(),
      );
    });

    it("returns to polling after OAuth completes", async () => {
      const conn = makeConn({ id: "conn_auth" });
      mockIsConnectionAuthenticated.mockResolvedValue({ supportsOAuth: true });

      mockUseSlotResolution.mockReturnValue(
        makeResolution({ initialPhase: "install" }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      const { rerender } = render(
        React.createElement(SlotCard, { slot, onComplete: () => {} }),
        { wrapper: createWrapper() },
      );
      fireEvent.click(screen.getByTestId("install-btn"));

      mockUseConnectionPoller.mockReturnValue(
        makePoller({ isTimedOut: true, connection: conn }),
      );
      rerender(React.createElement(SlotCard, { slot, onComplete: () => {} }));

      await waitFor(() => screen.getByTestId("oauth-btn"));
      fireEvent.click(screen.getByTestId("oauth-btn"));

      expect(screen.getByText("Connecting...")).toBeInTheDocument();
    });
  });

  describe("auth-token phase", () => {
    it("shows token input when polling times out and endpoint does not support OAuth", async () => {
      const conn = makeConn({ id: "conn_token" });
      mockIsConnectionAuthenticated.mockResolvedValue({ supportsOAuth: false });

      mockUseSlotResolution.mockReturnValue(
        makeResolution({ initialPhase: "install" }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      const { rerender } = render(
        React.createElement(SlotCard, { slot, onComplete: () => {} }),
        { wrapper: createWrapper() },
      );
      fireEvent.click(screen.getByTestId("install-btn"));

      mockUseConnectionPoller.mockReturnValue(
        makePoller({ isTimedOut: true, connection: conn }),
      );
      rerender(React.createElement(SlotCard, { slot, onComplete: () => {} }));

      await waitFor(() =>
        expect(screen.getByTestId("token-btn")).toBeInTheDocument(),
      );
    });

    it("returns to polling after token auth completes", async () => {
      const conn = makeConn({ id: "conn_token" });
      mockIsConnectionAuthenticated.mockResolvedValue({ supportsOAuth: false });

      mockUseSlotResolution.mockReturnValue(
        makeResolution({ initialPhase: "install" }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      const { rerender } = render(
        React.createElement(SlotCard, { slot, onComplete: () => {} }),
        { wrapper: createWrapper() },
      );
      fireEvent.click(screen.getByTestId("install-btn"));

      mockUseConnectionPoller.mockReturnValue(
        makePoller({ isTimedOut: true, connection: conn }),
      );
      rerender(React.createElement(SlotCard, { slot, onComplete: () => {} }));

      await waitFor(() => screen.getByTestId("token-btn"));
      fireEvent.click(screen.getByTestId("token-btn"));

      expect(screen.getByText("Connecting...")).toBeInTheDocument();
    });
  });

  describe("done phase", () => {
    it("shows the done card when an existing connection is already active", () => {
      const conn = makeConn({ id: "conn_abc", title: "OpenRouter" });
      mockUseSlotResolution.mockReturnValue(
        makeResolution({ initialPhase: "done", satisfiedConnection: conn }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      render(React.createElement(SlotCard, { slot, onComplete: () => {} }), {
        wrapper: createWrapper(),
      });

      expect(screen.getByTestId("done-connection")).toHaveTextContent(
        "OpenRouter",
      );
    });

    it("goes to picker when Change is clicked and existing connections are present", () => {
      const conn = makeConn({ id: "conn_abc", title: "OpenRouter" });
      mockUseSlotResolution.mockReturnValue(
        makeResolution({
          initialPhase: "done",
          satisfiedConnection: conn,
          matchingConnections: [conn],
        }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      render(React.createElement(SlotCard, { slot, onComplete: () => {} }), {
        wrapper: createWrapper(),
      });
      fireEvent.click(screen.getByTestId("change-btn"));

      expect(screen.getByText("Already installed:")).toBeInTheDocument();
    });

    it("goes to install when Change is clicked and no existing connections remain", () => {
      const conn = makeConn({ id: "conn_abc", title: "OpenRouter" });
      mockUseSlotResolution.mockReturnValue(
        makeResolution({
          initialPhase: "done",
          satisfiedConnection: conn,
          matchingConnections: [],
        }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      render(React.createElement(SlotCard, { slot, onComplete: () => {} }), {
        wrapper: createWrapper(),
      });
      fireEvent.click(screen.getByTestId("change-btn"));

      expect(screen.getByTestId("install-btn")).toBeInTheDocument();
    });

    it("calls onComplete with empty string when the user resets", () => {
      const conn = makeConn({ id: "conn_abc" });
      const onComplete = mock(() => {});
      mockUseSlotResolution.mockReturnValue(
        makeResolution({
          initialPhase: "done",
          satisfiedConnection: conn,
          matchingConnections: [],
        }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      render(React.createElement(SlotCard, { slot, onComplete }), {
        wrapper: createWrapper(),
      });
      fireEvent.click(screen.getByTestId("change-btn"));

      expect(onComplete).toHaveBeenCalledWith("");
    });
  });

  describe("picker phase", () => {
    it("lists all matching connections", () => {
      const conns = [
        makeConn({ id: "conn_1", title: "OpenRouter #1", status: "active" }),
        makeConn({ id: "conn_2", title: "OpenRouter #2", status: "inactive" }),
      ];
      mockUseSlotResolution.mockReturnValue(
        makeResolution({ initialPhase: "picker", matchingConnections: conns }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      render(React.createElement(SlotCard, { slot, onComplete: () => {} }), {
        wrapper: createWrapper(),
      });

      expect(screen.getByText("OpenRouter #1")).toBeInTheDocument();
      expect(screen.getByText("OpenRouter #2")).toBeInTheDocument();
    });

    it("transitions to done and calls onComplete when an active connection is selected", () => {
      const conn = makeConn({
        id: "conn_active",
        title: "OpenRouter",
        status: "active",
      });
      const onComplete = mock(() => {});
      mockUseSlotResolution.mockReturnValue(
        makeResolution({
          initialPhase: "picker",
          matchingConnections: [conn],
        }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      render(React.createElement(SlotCard, { slot, onComplete }), {
        wrapper: createWrapper(),
      });
      fireEvent.click(screen.getByText("OpenRouter"));

      expect(screen.getByTestId("slot-done")).toBeTruthy();
      expect(onComplete).toHaveBeenCalledWith("conn_active");
    });

    it("starts polling when an inactive connection is selected", () => {
      const conn = makeConn({
        id: "conn_inactive",
        title: "OpenRouter",
        status: "inactive",
      });
      mockUseSlotResolution.mockReturnValue(
        makeResolution({
          initialPhase: "picker",
          matchingConnections: [conn],
        }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      render(React.createElement(SlotCard, { slot, onComplete: () => {} }), {
        wrapper: createWrapper(),
      });
      fireEvent.click(screen.getByText("OpenRouter"));

      expect(screen.getByText("Connecting...")).toBeTruthy();
    });

    it("transitions to install when Install fresh is clicked", () => {
      const conn = makeConn({
        id: "conn_1",
        title: "OpenRouter",
        status: "active",
      });
      mockUseSlotResolution.mockReturnValue(
        makeResolution({
          initialPhase: "picker",
          matchingConnections: [conn],
        }),
      );
      mockUseConnectionPoller.mockReturnValue(makePoller());

      render(React.createElement(SlotCard, { slot, onComplete: () => {} }), {
        wrapper: createWrapper(),
      });
      fireEvent.click(screen.getByText("Install fresh"));

      expect(screen.getByTestId("install-btn")).toBeInTheDocument();
    });
  });
});
