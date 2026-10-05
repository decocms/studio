import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render as renderBare,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { PROTOCOL_NAME } from "@decocms/blocks/protocol";
import {
  DEFAULT_SERVE_ENDPOINT,
  serveCandidates,
} from "./deco-serve-connection";
import {
  isServeLost,
  LocalServeSwitch,
  SiteEditorGuide,
} from "./site-editor-guide";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

/** A `deco serve` answering on `ports` (changeable later); everything else refuses. */
function serveOn(ports: number[]) {
  return mock(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    const port = Number(new URL(request.url).port);
    if (!ports.includes(port)) throw new TypeError("Failed to fetch");
    const calls = (await request.json()) as { id: number; method: string }[];
    return Response.json(
      calls.map((call) =>
        call.method === "describe"
          ? {
              jsonrpc: "2.0",
              id: call.id,
              result: {
                protocol: PROTOCOL_NAME,
                version: { major: 1, minor: 0 },
                readOnly: false,
              },
            }
          : { jsonrpc: "2.0", id: call.id, result: { schema: {} } },
      ),
    );
  });
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("SiteEditorGuide", () => {
  test("with nothing answering, shows the guide, not an error", async () => {
    globalThis.fetch = serveOn([]) as unknown as typeof fetch;
    const view = render(
      <SiteEditorGuide
        candidates={[DEFAULT_SERVE_ENDPOINT]}
        onConnect={() => {}}
      />,
    );

    // A short "Looking…" first, then the guide once nothing answered.
    expect(view.getByText("Looking for deco serve…")).toBeInTheDocument();
    expect(
      await view.findByRole("heading", {
        level: 1,
        name: "Edit your site's content on your computer",
      }),
    ).toBeInTheDocument();
    expect(view.queryByText(/incomplete/i)).toBeNull();
    // The two steps, in order; no address field and no way to disconnect.
    const steps = view.getAllByRole("heading", { level: 2 });
    expect(steps.map((step) => step.textContent)).toEqual([
      "Start deco serve in your site's folder",
      "This page connects on its own",
    ]);
    expect(view.queryByRole("textbox")).toBeNull();
    expect(view.queryByRole("button", { name: /disconnect/i })).toBeNull();
    // The same command on any Studio origin: deco serve answers them all.
    expect(
      view.getByText(
        (_, element) =>
          element?.tagName === "CODE" &&
          element.textContent?.replace(/^\$\s*/, "") ===
            "npx @decocms/blocks serve",
      ),
    ).toBeInTheDocument();
    expect(
      view.getByRole("button", { name: "Copy command" }),
    ).toBeInTheDocument();
    expect(
      await view.findByText("Looking for deco serve on localhost:4545…"),
    ).toBeInTheDocument();
    // Docs links open in a new tab, from the one docs base.
    const docs = view.getByRole("navigation", { name: "Learn more" });
    const links = [...docs.querySelectorAll("a")];
    expect(links.length).toBe(4);
    for (const link of links) {
      expect(link.getAttribute("href")).toStartWith(
        "https://decocms.github.io/blocks/",
      );
      expect(link.getAttribute("target")).toBe("_blank");
    }
  });

  test("connects on its own when deco serve answers on 4545", async () => {
    globalThis.fetch = serveOn([4545]) as unknown as typeof fetch;
    const onConnect = mock(() => {});
    render(
      <SiteEditorGuide
        candidates={[DEFAULT_SERVE_ENDPOINT]}
        onConnect={onConnect}
      />,
    );
    await waitFor(() =>
      expect(onConnect).toHaveBeenCalledWith({
        endpoint: "http://localhost:4545/rpc",
      }),
    );
  });

  test("explains an invalid link above the steps", () => {
    globalThis.fetch = serveOn([]) as unknown as typeof fetch;
    const view = render(
      <SiteEditorGuide
        candidates={[DEFAULT_SERVE_ENDPOINT]}
        invalidLink
        onConnect={() => {}}
      />,
    );
    expect(
      view.getByText("This link doesn't point to deco serve on your computer"),
    ).toBeInTheDocument();
  });
});

/** The editor stand-in: names its server, and stops when the server does. */
function editor(
  connection: { endpoint: string },
  onLost: () => void,
): ReactNode {
  return (
    <div>
      <p>Editing {connection.endpoint}</p>
      <button type="button" onClick={onLost}>
        server stopped
      </button>
    </div>
  );
}

const GUIDE_TITLE = "Edit your site's content on your computer";

describe("LocalServeSwitch", () => {
  test("no link and nothing answering: the empty state", async () => {
    globalThis.fetch = serveOn([]) as unknown as typeof fetch;
    const view = render(
      <LocalServeSwitch
        candidates={serveCandidates(null, null)}
        editor={editor}
      />,
    );
    expect(
      await view.findByRole("heading", { level: 1, name: GUIDE_TITLE }),
    ).toBeInTheDocument();
    expect(view.queryByText(/^Editing/)).toBeNull();
  });

  test("the default port answering: the editor", async () => {
    globalThis.fetch = serveOn([4545]) as unknown as typeof fetch;
    const view = render(
      <LocalServeSwitch
        candidates={serveCandidates(null, null)}
        editor={editor}
      />,
    );
    expect(
      await view.findByText(`Editing ${DEFAULT_SERVE_ENDPOINT}`),
    ).toBeInTheDocument();
    expect(view.queryByRole("heading", { name: GUIDE_TITLE })).toBeNull();
  });

  test("the server stopping: the empty state, then the editor once it's back", async () => {
    const ports = [4545];
    globalThis.fetch = serveOn(ports) as unknown as typeof fetch;
    const view = render(
      <LocalServeSwitch
        candidates={serveCandidates(null, null)}
        editor={editor}
      />,
    );
    await view.findByText(`Editing ${DEFAULT_SERVE_ENDPOINT}`);

    ports.length = 0;
    fireEvent.click(view.getByRole("button", { name: "server stopped" }));
    expect(
      await view.findByRole("heading", { level: 1, name: GUIDE_TITLE }),
    ).toBeInTheDocument();

    ports.push(4545);
    expect(
      await view.findByText(
        `Editing ${DEFAULT_SERVE_ENDPOINT}`,
        {},
        { timeout: 4_000 },
      ),
    ).toBeInTheDocument();
  }, 10_000);

  test("a link's endpoint wins over the default port", async () => {
    globalThis.fetch = serveOn([4545, 4547]) as unknown as typeof fetch;
    const view = render(
      <LocalServeSwitch
        candidates={serveCandidates(
          { endpoint: "http://127.0.0.1:4547/rpc" },
          null,
        )}
        editor={editor}
      />,
    );
    expect(
      await view.findByText("Editing http://localhost:4547/rpc"),
    ).toBeInTheDocument();
  });
});

describe("isServeLost", () => {
  test("only a local server that stopped answering", () => {
    expect(
      isServeLost({
        kind: "unavailable",
        source: "local",
        problem: { reason: "not-answering" },
      }),
    ).toBe(true);
    expect(
      isServeLost({
        kind: "unavailable",
        source: "local",
        problem: { reason: "outdated" },
      }),
    ).toBe(false);
    expect(isServeLost({ kind: "unavailable", source: "github" })).toBe(false);
    expect(isServeLost({ kind: "pending" })).toBe(false);
  });
});
