/// <reference lib="dom" />
/// <reference types="@testing-library/jest-dom/matchers" />
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import type { SlotResolution } from "./use-slot-resolution";
import type { ConnectionPollerResult } from "./use-connection-poller";

// ── Module mocks ──────────────────────────────────────────────────────────────
// NOTE: deliberately NOT mocking ./slot-card — ConnectionsSetup is tested with
// the real SlotCard to avoid polluting the shared module registry for slot-card.test.tsx.

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
      { "data-testid": `done-${label}` },
      React.createElement(
        "span",
        { "data-testid": `done-title-${label}` },
        connection.title,
      ),
      React.createElement(
        "button",
        { "data-testid": `change-${label}`, onClick: onReset },
        "Change",
      ),
    ),
}));

mock.module("./slot-auth-oauth", () => ({
  SlotAuthOAuth: ({ onAuthed }: { onAuthed: () => void }) =>
    React.createElement("button", { onClick: onAuthed }, "Authorize"),
}));

mock.module("./slot-auth-token", () => ({
  SlotAuthToken: ({ onAuthed }: { onAuthed: () => void }) =>
    React.createElement("button", { onClick: onAuthed }, "Submit Token"),
}));

import { ConnectionsSetup } from "./connections-setup";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConn(overrides: Partial<ConnectionEntity> = {}): ConnectionEntity {
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

const twoSlots = {
  model: {
    label: "model",
    registry: "deco-registry",
    item_id: "deco/openrouter",
  },
  github: {
    label: "github",
    registry: "deco-registry",
    item_id: "deco/github",
  },
};

// Returns picker phase with a unique active connection per slot label so tests
// can click individual slots by text even after re-renders.
function setupPickerPerSlot() {
  mockUseSlotResolution.mockImplementation(
    // @ts-expect-error — Bun's mock type doesn't infer the slot arg but it is passed at runtime
    (slot: ConnectionSlot) => {
      const label = slot?.label ?? "unknown";
      return makeResolution({
        initialPhase: "picker",
        matchingConnections: [
          makeConn({
            id: `conn_${label}`,
            title: `${label}_conn`,
            status: "active",
          }),
        ],
      });
    },
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockUseSlotResolution.mockReset();
  mockUseConnectionPoller.mockReset();
  mockUseConnectionPoller.mockReturnValue(makePoller());
  mockUseSlotResolution.mockReturnValue(
    makeResolution({ initialPhase: "install" }),
  );
});

describe("ConnectionsSetup", () => {
  it("renders a card for each slot", () => {
    render(
      React.createElement(ConnectionsSetup, {
        slots: twoSlots,
        onComplete: () => {},
      }),
      { wrapper: createWrapper() },
    );

    // Both slots in install phase → each shows an install button
    expect(screen.getAllByTestId("install-btn").length).toBe(2);
  });

  it("does not call onComplete when only one of two slots is satisfied", () => {
    setupPickerPerSlot();
    const onComplete = mock(() => {});

    render(
      React.createElement(ConnectionsSetup, { slots: twoSlots, onComplete }),
      { wrapper: createWrapper() },
    );

    // Complete only the model slot
    fireEvent.click(screen.getByText("model_conn"));

    expect(onComplete).not.toHaveBeenCalled();
  });

  it("calls onComplete with slotId → connectionId map when all slots satisfy", () => {
    setupPickerPerSlot();
    const onComplete = mock(() => {});

    render(
      React.createElement(ConnectionsSetup, { slots: twoSlots, onComplete }),
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText("model_conn"));
    fireEvent.click(screen.getByText("github_conn"));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({
      model: "conn_model",
      github: "conn_github",
    });
  });

  it("does not call onComplete a second time on re-renders after completion", () => {
    setupPickerPerSlot();
    const onComplete = mock(() => {});

    const { rerender } = render(
      React.createElement(ConnectionsSetup, { slots: twoSlots, onComplete }),
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText("model_conn"));
    fireEvent.click(screen.getByText("github_conn"));

    rerender(
      React.createElement(ConnectionsSetup, { slots: twoSlots, onComplete }),
    );
    rerender(
      React.createElement(ConnectionsSetup, { slots: twoSlots, onComplete }),
    );

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("calls onComplete again after a completed slot is reset and re-satisfied", () => {
    setupPickerPerSlot();
    const onComplete = mock(() => {});

    render(
      React.createElement(ConnectionsSetup, { slots: twoSlots, onComplete }),
      { wrapper: createWrapper() },
    );

    // Complete both slots via picker
    fireEvent.click(screen.getByText("model_conn"));
    fireEvent.click(screen.getByText("github_conn"));
    expect(onComplete).toHaveBeenCalledTimes(1);

    // Reset model slot → goes back to picker (matchingConnections still exist)
    fireEvent.click(screen.getByTestId("change-model"));

    // Re-pick the active connection from the picker
    fireEvent.click(screen.getByText("model_conn"));

    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenLastCalledWith({
      model: "conn_model",
      github: "conn_github",
    });
  });
});
