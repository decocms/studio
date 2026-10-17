import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { ServeConnectState } from "./serve-connect-state";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

describe("ServeConnectState", () => {
  it("title, lead, numbered steps with a copyable command, footer", () => {
    const view = render(
      <ServeConnectState
        waiting
        title="Edit your site"
        lead="What it is."
        steps={[
          { title: "Start it", body: "Run:", command: "npx x serve" },
          { title: "It connects", after: <p>Looking…</p> },
        ]}
        footer={<p>Docs</p>}
      />,
    );
    expect(
      view.getByRole("heading", { level: 1, name: "Edit your site" }),
    ).toBeInTheDocument();
    expect(
      view.getByRole("heading", { level: 2, name: "Start it" }),
    ).toBeInTheDocument();
    expect(view.getAllByRole("listitem")).toHaveLength(2);
    expect(view.getByText("1")).toBeInTheDocument();
    expect(
      view.getByRole("button", { name: "Copy command" }),
    ).toBeInTheDocument();
    expect(view.getByText("Looking…")).toBeInTheDocument();
    expect(view.getByText("Docs")).toBeInTheDocument();
  });

  it("inside a tab: h2, steps h3", () => {
    const view = render(
      <ServeConnectState
        headingLevel={2}
        waiting={false}
        title="Waiting"
        steps={[{ title: "Only step" }]}
      />,
    );
    expect(
      view.getByRole("heading", { level: 2, name: "Waiting" }),
    ).toBeInTheDocument();
    expect(
      view.getByRole("heading", { level: 3, name: "Only step" }),
    ).toBeInTheDocument();
    // One step: no number.
    expect(view.queryByText("1")).not.toBeInTheDocument();
  });

  it("waiting: a dot shuttles on the wire; otherwise no dot", () => {
    const waiting = render(<ServeConnectState waiting title="Connecting" />);
    expect(waiting.getByRole("status")).toHaveTextContent("Connecting");
    const dot = waiting.getByTestId("connection-dot");
    expect(dot.className).toContain("animate-[connection-shuttle_");
    expect(dot.className).toContain("_infinite_alternate]");
    waiting.unmount();
    const idle = render(<ServeConnectState waiting={false} title="Problem" />);
    expect(idle.queryByTestId("connection-dot")).not.toBeInTheDocument();
    expect(idle.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reduced motion parks the dot mid-wire (static), in the keyframes", () => {
    const css = readFileSync(
      new URL(
        "../../../../../packages/ui/src/styles/global.css",
        import.meta.url,
      ),
      "utf8",
    );
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion"));
    expect(css).toContain("@keyframes connection-shuttle");
    expect(reduced).toMatch(
      /@keyframes connection-shuttle\s*{\s*from,\s*to\s*{\s*left: calc\(50% - 0\.25rem\);/,
    );
  });
});
