import { setupComponentTest } from "../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import {
  HTML_SWAP_EVENT,
  type WireframeIn,
  type WireframeOut,
} from "./messages";
import { startModule } from "./test-channel";
import wireframe from "./wireframe";

/** A page: a framework section (SEO) the runtime adds, then two editable ones. */
function page() {
  document.body.innerHTML = `
    <section data-manifest-key="website/sections/Seo/Seo.tsx"><p>seo</p></section>
    <section data-manifest-key="site/sections/Hero.tsx"><h1 id="hero">Hi</h1><a id="away" href="/other">Other</a><a id="frag" href="#top">Top</a></section>
    <section data-manifest-key="site/sections/Footer.tsx"><p id="footer">Bye</p></section>
  `;
  return {
    hero: document.getElementById("hero")!,
    footer: document.getElementById("footer")!,
  };
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

const sections: WireframeIn = {
  type: "wireframe:sections",
  labels: ["", "Saved footer"],
  kinds: ["normal", "global"],
  keys: [["site/sections/Hero.tsx"], ["site/sections/Footer.tsx"]],
};

async function start() {
  const channel = await startModule(wireframe);
  channel.receive(sections);
  channel.receive({ type: "wireframe:activate" });
  const outline = () =>
    document.querySelector<HTMLElement>('[data-deco-wireframe="outline"]');
  const badge = () =>
    document.querySelector<HTMLElement>('[data-deco-wireframe="badge"]');
  return { ...channel, outline, badge };
}

const selects = (sent: WireframeOut[]) =>
  sent.filter((m) => m.type === "wireframe:select");

describe("the wireframe module", () => {
  it("outlines the hovered editable section and reports its index, aligned past framework sections", async () => {
    const { hero, footer } = page();
    const { sent, outline, badge } = await start();
    hero.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    await frame();
    expect(outline()?.style.display).toBe("block");
    expect(badge()?.textContent).toBe("site/sections/Hero.tsx");
    expect(sent).toContainEqual({ type: "wireframe:hover", sectionIndex: 0 });

    footer.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    await frame();
    // A saved section shows its name, in its kind's color.
    expect(badge()?.textContent).toBe("Saved footer");
    expect(badge()?.style.background).toBe("#c084fc");
    expect(sent).toContainEqual({ type: "wireframe:hover", sectionIndex: 1 });
  });

  it("a framework section isn't editable: no outline, hover null", async () => {
    page();
    const { sent, outline } = await start();
    document
      .querySelector("section p")!
      .dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    await frame();
    expect(outline()?.style.display).toBe("none");
    expect(sent.filter((m) => m.type === "wireframe:hover")).toEqual([]);
  });

  it("reports a click as a selection, counting clicks", async () => {
    const { hero } = page();
    const { sent } = await start();
    hero.click();
    hero.click();
    expect(selects(sent)).toEqual([
      {
        type: "wireframe:select",
        sectionIndex: 0,
        manifestKey: "site/sections/Hero.tsx",
        clickSeq: 1,
      },
      {
        type: "wireframe:select",
        sectionIndex: 0,
        manifestKey: "site/sections/Hero.tsx",
        clickSeq: 2,
      },
    ]);
  });

  it("keeps the page from navigating away, but not from in-page links or its own handlers", async () => {
    page();
    await start();
    let heard = 0;
    document.addEventListener("click", () => heard++);
    const away = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.getElementById("away")!.dispatchEvent(away);
    expect(away.defaultPrevented).toBe(true);
    const frag = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.getElementById("frag")!.dispatchEvent(frag);
    expect(frag.defaultPrevented).toBe(false);
    expect(heard).toBe(2);
  });

  it("does nothing until activated, and stops on deactivate", async () => {
    const { hero } = page();
    const channel = await startModule(wireframe);
    hero.click();
    expect(selects(channel.sent)).toEqual([]);
    channel.receive({ type: "wireframe:activate" });
    hero.click();
    expect(selects(channel.sent)).toHaveLength(1);
    channel.receive({ type: "wireframe:deactivate" });
    hero.click();
    expect(selects(channel.sent)).toHaveLength(1);
    expect(document.querySelector("[data-deco-wireframe]")).toBeNull();
  });

  it("clears on clear-hover, and follows an HTML swap onto the new body", async () => {
    const { hero } = page();
    const { sent, outline, receive } = await start();
    hero.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    await frame();
    receive({ type: "wireframe:clear-hover" });
    expect(outline()?.style.display).toBe("none");
    expect(sent.at(-1)).toEqual({
      type: "wireframe:hover",
      sectionIndex: null,
    });

    dispatchEvent(
      new CustomEvent(HTML_SWAP_EVENT, { detail: { phase: "start" } }),
    );
    // The swap replaced the body: the outline went with it.
    const fresh = page();
    expect(outline()).toBeNull();
    dispatchEvent(
      new CustomEvent(HTML_SWAP_EVENT, { detail: { phase: "end" } }),
    );
    expect(outline()).not.toBeNull();
    fresh.footer.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    await frame();
    expect(outline()?.style.display).toBe("block");
    expect(sent.at(-1)).toEqual({ type: "wireframe:hover", sectionIndex: 1 });
  });

  // osklen's shape: the layout's own <header>/<footer> roots carry the key,
  // the header renders before a SEO section saved ahead of it in the array.
  it("selects marked non-<section> roots, aligned by key out of order", async () => {
    document.body.innerHTML = `
      <header data-manifest-key="site/sections/Header.tsx"><nav id="nav">Menu</nav></header>
      <main>
        <section data-manifest-key="site/sections/Seo/SeoTitle.tsx"><h1 id="title">T</h1></section>
        <section data-manifest-key="site/sections/Hero.tsx"><div id="hero" data-manifest-key="site/sections/Inner.tsx">Hi</div></section>
      </main>
      <div data-manifest-key="site/sections/Footer.tsx"><footer id="footer">Bye</footer></div>
    `;
    const channel = await startModule(wireframe);
    channel.receive({
      type: "wireframe:sections",
      labels: [],
      kinds: [],
      keys: [
        ["site/sections/Seo/SeoTitle.tsx"],
        ["site/sections/Header.tsx"],
        ["site/sections/Hero.tsx"],
        ["site/sections/Footer.tsx"],
        ["site/sections/PageChrome.tsx"],
      ],
    });
    channel.receive({ type: "wireframe:activate" });
    const click = (id: string) => document.getElementById(id)!.click();
    click("nav");
    click("title");
    click("hero");
    click("footer");
    expect(
      selects(channel.sent).map((m) =>
        m.type === "wireframe:select" ? [m.sectionIndex, m.manifestKey] : null,
      ),
    ).toEqual([
      [1, "site/sections/Header.tsx"],
      [0, "site/sections/Seo/SeoTitle.tsx"],
      // The marker inside Hero is Hero's own, not a page section.
      [2, "site/sections/Hero.tsx"],
      [3, "site/sections/Footer.tsx"],
    ]);
  });

  it("scrolls the section picked in the editor's list smoothly to the top of the view", async () => {
    page();
    const channel = await start();
    const calls: [string | null, unknown][] = [];
    for (const section of document.querySelectorAll("section")) {
      section.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
        calls.push([section.getAttribute("data-manifest-key"), options]);
      };
    }
    channel.receive({ type: "wireframe:scroll-to", sectionIndex: 1 });
    // Out of range, negative or not an index: nothing scrolls.
    channel.receive({ type: "wireframe:scroll-to", sectionIndex: 7 });
    channel.receive({ type: "wireframe:scroll-to", sectionIndex: -1 });
    channel.receive({ type: "wireframe:scroll-to", sectionIndex: 0.5 });
    expect(calls).toEqual([
      ["site/sections/Footer.tsx", { behavior: "smooth", block: "start" }],
    ]);
  });
});
