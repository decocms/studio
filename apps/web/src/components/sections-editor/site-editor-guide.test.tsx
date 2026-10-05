import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render as renderBare,
  type RenderResult,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { PROTOCOL_NAME } from "@decocms/blocks/protocol";
import { SiteEditorGuide } from "./site-editor-guide";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

/** A `deco serve` answering on `ports`; everything else refuses. */
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
  test("with no link and nothing remembered, shows the guide, not an error", async () => {
    globalThis.fetch = serveOn([]) as unknown as typeof fetch;
    const view = render(
      <SiteEditorGuide remembered={null} onConnect={() => {}} />,
    );

    expect(
      view.getByRole("heading", {
        level: 1,
        name: "Edit your site's content on your computer",
      }),
    ).toBeInTheDocument();
    expect(view.queryByText(/incomplete/i)).toBeNull();
    // The three steps, in order.
    const steps = view.getAllByRole("heading", { level: 2 });
    expect(steps.map((step) => step.textContent)).toEqual([
      "Start deco serve in your site's folder",
      "This page connects on its own",
      "Using another port?",
    ]);
    // Studio runs on localhost:4000 here, so the command allows that origin.
    expect(
      view.getByText(
        "npx @decocms/blocks serve --allow-origin http://localhost:4000",
      ),
    ).toBeInTheDocument();
    expect(
      view.getByRole("button", { name: "Copy command" }),
    ).toBeInTheDocument();
    expect(
      await view.findByText("Looking for deco serve on 127.0.0.1:4545…"),
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
    render(<SiteEditorGuide remembered={null} onConnect={onConnect} />);
    await waitFor(() =>
      expect(onConnect).toHaveBeenCalledWith({
        endpoint: "http://127.0.0.1:4545/rpc",
      }),
    );
  });

  test("explains an invalid link above the steps", () => {
    globalThis.fetch = serveOn([]) as unknown as typeof fetch;
    const view = render(
      <SiteEditorGuide remembered={null} invalidLink onConnect={() => {}} />,
    );
    expect(
      view.getByText("This link doesn't point to deco serve on your computer"),
    ).toBeInTheDocument();
  });

  describe("Using another port?", () => {
    const submit = (view: RenderResult, value: string) => {
      fireEvent.input(view.getByLabelText("deco serve address"), {
        target: { value },
      });
      const button = view.getByRole("button", { name: "Connect" });

      fireEvent.submit(button.closest("form")!);
    };

    test("connects to a typed port", async () => {
      globalThis.fetch = serveOn([4547]) as unknown as typeof fetch;
      const onConnect = mock(() => {});
      const view = render(
        <SiteEditorGuide remembered={null} onConnect={onConnect} />,
      );
      submit(view, "4547");
      await waitFor(() =>
        expect(onConnect).toHaveBeenCalledWith({
          endpoint: "http://127.0.0.1:4547/rpc",
        }),
      );
    });

    test("connects to a pasted Site editor link", async () => {
      globalThis.fetch = serveOn([4548]) as unknown as typeof fetch;
      const onConnect = mock(() => {});
      const view = render(
        <SiteEditorGuide remembered={null} onConnect={onConnect} />,
      );
      submit(
        view,
        `http://localhost:4000/site-editor#endpoint=${encodeURIComponent("http://127.0.0.1:4548/rpc")}`,
      );
      await waitFor(() =>
        expect(onConnect).toHaveBeenCalledWith({
          endpoint: "http://127.0.0.1:4548/rpc",
        }),
      );
    });

    test("rejects junk with guidance, without a request", async () => {
      const fetchMock = serveOn([]);
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const onConnect = mock(() => {});
      const view = render(
        <SiteEditorGuide remembered={null} onConnect={onConnect} />,
      );
      submit(view, "hello world");
      const alert = await view.findByText(/That isn't a deco serve address/);
      expect(alert).toBeInTheDocument();
      expect(view.getByLabelText("deco serve address")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
      expect(onConnect).not.toHaveBeenCalled();
    });

    test("rejects an address off this machine", async () => {
      globalThis.fetch = serveOn([]) as unknown as typeof fetch;
      const view = render(
        <SiteEditorGuide remembered={null} onConnect={() => {}} />,
      );
      submit(view, "example.com:4545");
      expect(
        await view.findByText(/must use 127\.0\.0\.1 or localhost/),
      ).toBeInTheDocument();
    });

    test("says when nothing answers on that port", async () => {
      globalThis.fetch = serveOn([]) as unknown as typeof fetch;
      const onConnect = mock(() => {});
      const view = render(
        <SiteEditorGuide remembered={null} onConnect={onConnect} />,
      );
      submit(view, "4999");
      expect(
        await view.findByText(/Nothing answered on 127\.0\.0\.1:4999/),
      ).toBeInTheDocument();
      expect(onConnect).not.toHaveBeenCalled();
    });
  });
});
