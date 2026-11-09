import { setupComponentTest } from "../../test/setup";
setupComponentTest();
import { afterEach, describe, expect, it } from "bun:test";
import htmlSwap from "./html-swap";
import { HTML_SWAP_EVENT, type HtmlSwapOut } from "./messages";
import { startModule } from "./test-channel";

const realFetch = globalThis.fetch;
/** Gives the document a `startViewTransition` (null: none, as in browsers without the API). */
function viewTransitions(
  start: ((update: () => void) => Record<string, Promise<void>>) | null,
) {
  if (!start) {
    Reflect.deleteProperty(document, "startViewTransition");
    return;
  }
  Object.defineProperty(document, "startViewTransition", {
    value: start,
    configurable: true,
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  viewTransitions(null);
  document.documentElement.removeAttribute("data-theme");
});

const NEXT = `<!doctype html><html lang="pt" data-theme="dark"><head><title>New</title><link rel="stylesheet" href="data:text/css,h1%7B%7D"></head><body><section data-manifest-key="site/sections/Hero.tsx"><h1>Saved title</h1></section></body></html>`;

/** Answers the page's URL with `html`, and the stylesheet; records what was fetched. */
function serve(html: string, status = 200) {
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.startsWith("data:text/css")) return new Response("h1{}");
    return new Response(html, { status });
  }) as typeof fetch;
  return fetched;
}

/** Waits until the module said `type` for refresh `id`. */
async function until(
  sent: HtmlSwapOut[],
  type: HtmlSwapOut["type"],
  id: number,
) {
  for (let i = 0; i < 100; i++) {
    if (sent.some((m) => m.type === type && m.id === id)) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`no ${type} for ${id}: ${JSON.stringify(sent)}`);
}

describe("the HTML swap module", () => {
  it("fetches the page again and swaps the document, reporting start then end", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    document.body.innerHTML = "<h1>Old title</h1>";
    const fetched = serve(NEXT);
    const phases: string[] = [];
    const onSwap = (e: Event) => phases.push((e as CustomEvent).detail.phase);
    addEventListener(HTML_SWAP_EVENT, onSwap);
    const { sent, receive } = await startModule(htmlSwap);
    receive({ type: "html-swap:refresh", id: 7 });
    expect(sent).toEqual([{ type: "html-swap:start", id: 7 }]);
    await until(sent, "html-swap:end", 7);
    removeEventListener(HTML_SWAP_EVENT, onSwap);
    expect(sent).toEqual([
      { type: "html-swap:start", id: 7 },
      { type: "html-swap:end", id: 7 },
    ]);
    expect(phases).toEqual(["start", "end"]);
    // The page's own URL, then its new stylesheet, before the swap.
    expect(fetched[0]).toBe(location.href);
    expect(fetched[1]).toBe("data:text/css,h1%7B%7D");
    expect(document.querySelector("h1")?.textContent).toBe("Saved title");
    expect(document.title).toBe("New");
    expect(document.documentElement.getAttribute("lang")).toBe("pt");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    // The swap's own no-transitions style is gone afterwards.
    expect(document.getElementById("deco-studio-no-transitions")).toBeNull();
  });

  it("swaps inside a View Transition when the browser has them", async () => {
    document.body.innerHTML = "<h1>Old title</h1>";
    serve(NEXT);
    let transitions = 0;
    viewTransitions((update) => {
      transitions++;
      update();
      return { finished: Promise.resolve() };
    });
    const { sent, receive } = await startModule(htmlSwap);
    receive({ type: "html-swap:refresh", id: 1 });
    await until(sent, "html-swap:end", 1);
    expect(transitions).toBe(1);
    expect(document.querySelector("h1")?.textContent).toBe("Saved title");
  });

  it("a skipped transition still ends the swap", async () => {
    serve(NEXT);
    viewTransitions((update) => {
      update();
      return {
        finished: Promise.reject(
          new Error("AbortError: Transition was skipped"),
        ),
        ready: Promise.reject(new Error("skipped")),
      };
    });
    const { sent, receive } = await startModule(htmlSwap);
    receive({ type: "html-swap:refresh", id: 1 });
    await until(sent, "html-swap:end", 1);
  });

  it("reports an error when the page doesn't answer, so Studio reloads", async () => {
    document.body.innerHTML = "<h1>Old title</h1>";
    serve("oops", 502);
    const { sent, receive } = await startModule(htmlSwap);
    receive({ type: "html-swap:refresh", id: 3 });
    await until(sent, "html-swap:error", 3);
    expect(sent.at(-1)).toEqual({
      type: "html-swap:error",
      id: 3,
      message: "The page answered 502",
    });
    expect(document.querySelector("h1")?.textContent).toBe("Old title");
  });

  it("shows a new URL of the page (a moved draft pointer), which later refreshes read", async () => {
    document.body.innerHTML = "<h1>Old title</h1>";
    const fetched = serve(NEXT);
    const before = location.href;
    const next = new URL("?__draft=moved", location.href).href;
    const { sent, receive } = await startModule(htmlSwap);
    receive({ type: "html-swap:refresh", id: 4, url: next });
    await until(sent, "html-swap:end", 4);
    expect(fetched[0]).toBe(next);
    expect(document.querySelector("h1")?.textContent).toBe("Saved title");
    // The address stays: the page's router never hears of the swap.
    expect(location.href).toBe(before);
    fetched.length = 0;
    receive({ type: "html-swap:refresh", id: 5 });
    await until(sent, "html-swap:end", 5);
    expect(fetched[0]).toBe(next);
  });

  it("never fetches a URL on another origin", async () => {
    document.body.innerHTML = "<h1>Old title</h1>";
    const fetched = serve(NEXT);
    const { sent, receive } = await startModule(htmlSwap);
    receive({
      type: "html-swap:refresh",
      id: 5,
      url: "https://elsewhere.example/?__draft=x",
    });
    await until(sent, "html-swap:error", 5);
    expect(fetched).toEqual([]);
    expect(document.querySelector("h1")?.textContent).toBe("Old title");
  });

  it("a later refresh supersedes one under way: only the latest reports its end", async () => {
    serve(NEXT);
    const { sent, receive } = await startModule(htmlSwap);
    receive({ type: "html-swap:refresh", id: 1 });
    receive({ type: "html-swap:refresh", id: 2 });
    await until(sent, "html-swap:end", 2);
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.filter((m) => m.type !== "html-swap:start")).toEqual([
      { type: "html-swap:end", id: 2 },
    ]);
  });
});
