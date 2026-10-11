import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { fireEvent, render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import type { ContentBackend } from "@/components/sections-editor/content-backend";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import {
  LocalhostRow,
  type LocalhostStatus,
  localhostStatus,
} from "./localhost-row";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const local = (problem?: { reason: "not-answering" | "other-site" }) =>
  ({ kind: "unavailable", source: "local", problem }) as ContentBackend;
const connected = {
  kind: "protocol",
  source: "local",
} as unknown as ContentBackend;

describe("localhostStatus", () => {
  it("maps the editor's backend and Chrome's permission to one state", () => {
    const at = (
      selected: boolean,
      backend: ContentBackend,
      access: "granted" | "denied" = "granted",
    ) => localhostStatus({ selected, backend, access }).kind;
    expect(at(false, connected)).toBe("available");
    expect(at(true, { kind: "pending" })).toBe("connecting");
    expect(at(true, connected)).toBe("connected");
    expect(at(true, local({ reason: "not-answering" }))).toBe("not-running");
    expect(at(true, local({ reason: "not-answering" }), "denied")).toBe(
      "needs-permission",
    );
    expect(at(true, local({ reason: "other-site" }))).toBe("problem");
  });
});

describe("LocalhostRow", () => {
  const renderRow = (status: LocalhostStatus) => {
    const onSelect = mock(() => {});
    const onTurnOff = mock(() => {});
    const view = renderBare(
      <LocalhostRow
        status={status}
        host="localhost:4545"
        onSelect={onSelect}
        onTurnOff={onTurnOff}
      />,
      { wrapper },
    );
    return { ...view, onSelect, onTurnOff };
  };

  it("available: says what it is; choosing it calls onSelect", () => {
    const { getByText, getByRole, queryByRole, onSelect } = renderRow({
      kind: "available",
    });
    expect(
      getByText("Edit the site running on your computer"),
    ).toBeInTheDocument();
    expect(
      queryByRole("button", { name: "Stop using Localhost" }),
    ).not.toBeInTheDocument();
    fireEvent.click(getByRole("button", { pressed: false }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("connecting and connected", () => {
    const connecting = renderRow({ kind: "connecting" });
    expect(connecting.getByText("Connecting…")).toBeInTheDocument();
    connecting.unmount();
    const { getByText, getByRole, onTurnOff } = renderRow({
      kind: "connected",
    });
    expect(getByText("Connected to localhost:4545")).toBeInTheDocument();
    fireEvent.click(getByRole("button", { name: "Stop using Localhost" }));
    expect(onTurnOff).toHaveBeenCalledTimes(1);
  });

  it("not running: the command with a copy button, and it keeps trying", () => {
    const { getByText, getByRole } = renderRow({ kind: "not-running" });
    expect(getByText("deco serve")).toBeInTheDocument();
    expect(getByRole("button", { name: "Copy command" })).toBeInTheDocument();
    expect(
      getByText("We'll connect as soon as it starts."),
    ).toBeInTheDocument();
  });

  it("needs permission: how to allow Studio to reach this computer", () => {
    expect(
      renderRow({ kind: "needs-permission" }).getByText(
        "Chrome is blocking Studio from reaching your computer",
      ),
    ).toBeInTheDocument();
  });

  it("another site: explains it, names the other site", () => {
    const { getByRole, getByText } = renderRow({
      kind: "problem",
      problem: { reason: "other-site", detail: "other-store" },
    });
    expect(getByRole("alert")).toBeInTheDocument();
    expect(getByText("This is another site")).toBeInTheDocument();
    expect(getByText(/running the site other-store/)).toBeInTheDocument();
  });

  it("update needed when it can't tell the site", () => {
    expect(
      renderRow({
        kind: "problem",
        problem: { reason: "site-unverified" },
      }).getByText("Update deco serve to connect"),
    ).toBeInTheDocument();
  });
});

describe("the Localhost choice is remembered per user and project", () => {
  it("keys the connection on both", () => {
    expect(LOCALSTORAGE_KEYS.decoServeConnection("u1", "vmcp")).toBe(
      "studio:deco-serve-connection:u1:vmcp",
    );
    expect(LOCALSTORAGE_KEYS.decoServeConnection("u2", "vmcp")).not.toBe(
      LOCALSTORAGE_KEYS.decoServeConnection("u1", "vmcp"),
    );
  });
});
