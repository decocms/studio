import { describe, expect, test } from "bun:test";
import { fakeBrowser } from "../fixtures/fake-browser.ts";
import {
  chooseOptionInPage,
  clickPointInPage,
  clickSnapshotInPage,
  dismissOverlaysInPage,
  elementFactsInPage,
  elementLabelsInPage,
  measurePdpInPage,
  scrollToCenterInPage,
} from "../page-scripts.ts";
import type { BrowserPage, MediaStore } from "../ports.ts";
import type { PageCapture } from "../types.ts";
import {
  capObserved,
  clipAround,
  describeClickChange,
  describeFacts,
  GESTURE_PATH,
  isHiddenTarget,
  partsOf,
  performGesture,
  runLiveCheck,
  selectorCandidates,
  selectorFor,
} from "./live.ts";
import type { ClickSnapshot, ElementFacts } from "./safety.ts";
import type { VerifyCheck } from "./types.ts";

const capture = {
  selectors: {
    price: "div.price > span.value",
    size_selector: "ul.sizes",
    buy_button: "button.buy",
    shipping: null,
    first_recommendation: "h2.reco",
  },
} as unknown as PageCapture;

const snap = (over: Partial<ClickSnapshot> = {}): ClickSnapshot => ({
  url: "https://loja-exemplo.com.br/vestido/p",
  activeTag: "body",
  selection: "",
  nearHtmlHash: "abc",
  openDialogs: 0,
  ...over,
});

describe("selectorFor", () => {
  test("an element becomes the anchor elementLabelsInPage writes", () => {
    expect(selectorFor({ kind: "element", key: "a#0|123" }, capture)).toBe(
      '[data-ux-anchor="a#0|123"]',
    );
  });

  test("a part uses the capture's selector", () => {
    expect(selectorFor({ kind: "part", part: "price" }, capture)).toBe(
      "div.price > span.value",
    );
  });

  test("a part with no selector in the capture is null", () => {
    expect(selectorFor({ kind: "part", part: "shipping" }, capture)).toBeNull();
  });

  test("quotes in the key do not break the selector", () => {
    expect(selectorFor({ kind: "element", key: 'a"b|1' }, capture)).toBe(
      '[data-ux-anchor="a\\"b|1"]',
    );
  });
});

describe("describeClickChange", () => {
  test("a different URL is a navigation", () => {
    const r = describeClickChange(
      snap(),
      snap({ url: "https://loja-exemplo.com.br/outro/p" }),
    );
    expect(r.navigated).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.text).toContain("https://loja-exemplo.com.br/outro/p");
  });

  test("only the selection changed", () => {
    const r = describeClickChange(
      snap(),
      snap({ selection: "Vestido Floral" }),
    );
    expect(r.navigated).toBe(false);
    expect(r.changed).toBe(true);
    expect(r.text).toContain("seleção de texto");
  });

  test("all equal: nothing changed", () => {
    const r = describeClickChange(snap(), snap());
    expect(r.changed).toBe(false);
    expect(r.navigated).toBe(false);
    expect(r.text).toContain("nada mudou");
  });

  test("only the #hash changing is not a navigation", () => {
    const r = describeClickChange(
      snap(),
      snap({ url: "https://loja-exemplo.com.br/vestido/p#avaliacoes" }),
    );
    expect(r.navigated).toBe(false);
    expect(r.changed).toBe(true);
  });

  test("a dialog opened", () => {
    const r = describeClickChange(snap(), snap({ openDialogs: 1 }));
    expect(r.changed).toBe(true);
    expect(r.text).toContain("diálogo");
  });
});

const facts = (over: Partial<ElementFacts> = {}): ElementFacts => ({
  found: true,
  tag: "h1",
  text: "Relógio Feminino Dourado",
  role: null,
  type: null,
  inLink: false,
  inButton: false,
  href: null,
  linkTarget: null,
  cursor: "pointer",
  color: "#1a0dab",
  parentColor: "#222222",
  textDecoration: "none",
  hasClickHandler: true,
  inForm: false,
  inputType: null,
  rect: { x: 16, y: 480, width: 358, height: 48 },
  ...over,
});

describe("describeFacts", () => {
  test("reports cursor, colours, underline and link", () => {
    const t = describeFacts(facts());
    expect(t).toContain("cursor pointer");
    expect(t).toContain("#1a0dab");
    expect(t).toContain("#222222");
    expect(t).toContain("sem sublinhado");
    expect(t).toContain("fora de <a>");
  });

  test("inside a link shows the href", () => {
    const t = describeFacts(
      facts({ inLink: true, href: "/vestido/p", textDecoration: "underline" }),
    );
    expect(t).toContain("dentro de <a href=/vestido/p>");
    expect(t).toContain("sublinhado");
    expect(t).not.toContain("sem sublinhado");
  });
});

describe("clipAround", () => {
  test("screen width with padding around the element", () => {
    const c = clipAround(
      { x: 16, y: 480, width: 358, height: 48 },
      { width: 390, height: 844 },
    );
    expect(c.x).toBe(0);
    expect(c.width).toBe(390);
    expect(c.y).toBeLessThan(480);
    expect(c.y + c.height).toBeGreaterThan(528);
  });

  test("does not go above the top", () => {
    const c = clipAround(
      { x: 0, y: 10, width: 100, height: 20 },
      { width: 390, height: 844 },
    );
    expect(c.y).toBe(0);
  });

  test("a huge element is cut to one screen", () => {
    const c = clipAround(
      { x: 0, y: 100, width: 390, height: 5000 },
      { width: 390, height: 844 },
    );
    expect(c.height).toBeLessThanOrEqual(844);
  });
});

describe("capObserved", () => {
  test("joins the steps", () => {
    expect(capObserved(["a", "b"])).toBe("a\nb");
  });

  test("cuts the middle and keeps the last line (why it stopped)", () => {
    const lines = [
      ...Array.from({ length: 100 }, () => "x".repeat(50)),
      "clicar aqui mexeria na loja (botão de compra)",
    ];
    const out = capObserved(lines);
    expect(out.length).toBeLessThanOrEqual(1200);
    expect(out.startsWith("x")).toBe(true);
    expect(out).toContain("…");
    expect(out.endsWith("clicar aqui mexeria na loja (botão de compra)")).toBe(
      true,
    );
  });
});

// ── runLiveCheck with a fake page ────────────────────────────────────────────

type Handler = (...args: unknown[]) => unknown;

interface FakeOpts {
  /** Facts by selector; absent = not found. */
  facts?: Record<string, Partial<ElementFacts>>;
  /** Result of the click point hit test. */
  point?: { found: boolean; covered: boolean; x: number; y: number };
  /** What the click does to the page. */
  onClick?: (page: FakeControl) => void;
  /** A step that throws. */
  throwOn?: unknown;
  /** Tracking requests the page aborted. */
  blocked?: number;
  /** What measurePdpInPage measures on the check's page (per call). */
  measured?: Array<{
    selectors: Record<string, string | null>;
    positions: Record<string, number | null>;
  }>;
}

interface FakeControl {
  setUrl(url: string): void;
  /** A main-frame navigation request not yet finished. */
  emitNavigation(url: string): void;
}

const NO_BROWSER = fakeBrowser(() => ({})).browser;
const NO_MEDIA: MediaStore = {
  put: async (path) => path,
  get: async () => null,
  url: async (path) => path,
};

function fakePage(o: FakeOpts = {}) {
  let url = "https://loja-exemplo.com.br/vestido/p";
  let navigation: string | null = null;
  const calls = {
    clicks: 0,
    /** Mouse moves, in order. */
    pointer: [] as string[],
    evaluated: [] as unknown[],
    closed: false,
    /** What happened, in order: evaluated function names and "click". */
    timeline: [] as string[],
    /** Each measurePdpInPage argument. */
    measureOpts: [] as unknown[],
  };
  // The fake snapshot hash depends on data-ux-* marks, like the real outerHTML.
  const marks = new Set<string>();
  const control: FakeControl = {
    setUrl: (u) => {
      url = u;
    },
    emitNavigation: (u) => {
      navigation = u;
    },
  };
  const handlers = new Map<unknown, Handler>([
    [
      elementLabelsInPage,
      () => {
        marks.add("anchor");
        return {};
      },
    ],
    [
      elementFactsInPage,
      (sel) => {
        const f = o.facts?.[sel as string];
        return f
          ? { ...factsBase(), ...f }
          : { ...factsBase(), found: false, rect: null };
      },
    ],
    [scrollToCenterInPage, () => true],
    [
      measurePdpInPage,
      (opts) => {
        calls.measureOpts.push(opts);
        return o.measured?.shift();
      },
    ],
    [
      clickPointInPage,
      () => {
        marks.add("hit");
        return o.point ?? { found: true, covered: false, x: 100, y: 200 };
      },
    ],
    [
      clickSnapshotInPage,
      () => ({ ...snap(), url, nearHtmlHash: [...marks].sort().join(",") }),
    ],
    [
      chooseOptionInPage,
      () => {
        marks.add("choice");
        return "P";
      },
    ],
  ]);
  const page: BrowserPage = {
    viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
    url: () => url,
    goto: async () => ({ status: 200, error: null }),
    evaluate: async <A extends unknown[], R>(
      fn: (...args: A) => R,
      ...args: A
    ): Promise<Awaited<R>> => {
      calls.evaluated.push(fn);
      calls.timeline.push(fn.name || "?");
      if (o.throwOn && fn === o.throwOn) throw new Error("explodiu");
      const h = handlers.get(fn);
      return (h ? h(...args) : undefined) as Awaited<R>;
    },
    mouseMove: async (x: number, y: number) => {
      calls.pointer.push(`move ${x},${y}`);
    },
    click: async () => {
      calls.clicks++;
      calls.timeline.push("click");
      navigation = null;
      o.onClick?.(control);
      return { navigation };
    },
    reload: async () => {},
    screenshot: async () => new Uint8Array(),
    blockedRequests: () => o.blocked ?? 0,
    close: async () => {
      calls.closed = true;
    },
  };
  return { page, calls };
}

const factsBase = (): ElementFacts => ({
  found: true,
  tag: "h1",
  text: "Vestido Floral",
  role: null,
  type: null,
  inLink: false,
  inButton: false,
  href: null,
  linkTarget: null,
  cursor: "pointer",
  color: "#1a0dab",
  parentColor: "#222222",
  textDecoration: "none",
  hasClickHandler: true,
  inForm: false,
  inputType: null,
  rect: { x: 0, y: 400, width: 300, height: 40 },
});

const TITLE = { kind: "element", key: "r#0|1" } as const;
const TITLE_SEL = '[data-ux-anchor="r#0|1"]';
const HIT = "[data-ux-hit]";

const liveCheck = (steps: VerifyCheck["steps"]): VerifyCheck => ({
  id: "c1",
  claim: "o título parece link",
  stage: "live",
  device: "mobile",
  steps,
  question: null,
  confirms_if: "nada acontece",
  refutes_if: "navega",
});

const fullCapture = {
  ...capture,
  url: "https://loja-exemplo.com.br/vestido/p",
  viewport: { width: 390, height: 844 },
  element_labels: { "r#0|1": { label: 'h1 "Vestido Floral"', y: 400 } },
} as unknown as PageCapture;

async function runWith(fake: ReturnType<typeof fakePage>, check: VerifyCheck) {
  return runLiveCheck({
    browser: NO_BROWSER,
    capture: fullCapture,
    check,
    elementKeys: ["r#0|1"],
    media: NO_MEDIA,
    keyPrefix: "ux/d1/verify/h1",
    io: {
      openPage: async () => fake.page,
      sleep: async () => {},
    },
  });
}

describe("runLiveCheck", () => {
  test("a target missing on this PDP: nao_testou, target not found", async () => {
    const fake = fakePage({ facts: {} });
    const r = await runWith(
      fake,
      liveCheck([{ op: "open" }, { op: "inspect", target: TITLE }]),
    );
    expect(r.outcome).toBe("nao_testou");
    expect(r.observed).toContain("não achei o alvo");
    expect(fake.calls.closed).toBe(true);
  });

  test("a forbidden target: nao_testou and never clicks", async () => {
    const fake = fakePage({
      facts: {
        [TITLE_SEL]: { tag: "button", text: "Adicionar à sacola" },
        [HIT]: { tag: "button", text: "Adicionar à sacola" },
      },
    });
    const r = await runWith(
      fake,
      liveCheck([{ op: "open" }, { op: "observe_click", target: TITLE }]),
    );
    expect(r.outcome).toBe("nao_testou");
    expect(r.observed).toContain("clicar aqui mexeria na loja");
    expect(fake.calls.clicks).toBe(0);
  });

  test("what sits on top at the click point is forbidden: does not click", async () => {
    // The title passes, but its centre lands on a child that is a buy button.
    const fake = fakePage({
      facts: {
        [TITLE_SEL]: {},
        [HIT]: { tag: "button", text: "Comprar" },
      },
    });
    const r = await runWith(
      fake,
      liveCheck([{ op: "open" }, { op: "click", target: TITLE }]),
    );
    expect(r.outcome).toBe("nao_testou");
    expect(r.observed).toContain("clicar aqui mexeria na loja");
    expect(fake.calls.clicks).toBe(0);
  });

  test("another element covers the target: nao_testou and does not click", async () => {
    const fake = fakePage({
      facts: {
        [TITLE_SEL]: {},
        [HIT]: { tag: "div", text: "barra fixa" },
      },
      point: { found: true, covered: true, x: 100, y: 200 },
    });
    const r = await runWith(
      fake,
      liveCheck([{ op: "open" }, { op: "click", target: TITLE }]),
    );
    expect(r.outcome).toBe("nao_testou");
    expect(r.observed).toContain("outro elemento cobre o alvo");
    expect(fake.calls.clicks).toBe(0);
  });

  test("a step that throws: nao_testou and the following ones do not run", async () => {
    const fake = fakePage({
      facts: { [TITLE_SEL]: {}, [HIT]: {} },
      throwOn: chooseOptionInPage,
    });
    const r = await runWith(
      fake,
      liveCheck([
        { op: "open" },
        { op: "choose_size" },
        { op: "click", target: TITLE },
      ]),
    );
    expect(r.outcome).toBe("nao_testou");
    expect(r.observed).toContain("explodiu");
    expect(fake.calls.clicks).toBe(0);
  });

  test("an observe_click that navigated ends the check", async () => {
    const fake = fakePage({
      facts: {
        [TITLE_SEL]: { inLink: true, href: "/vestido-floral/p" },
        [HIT]: { inLink: true, href: "/vestido-floral/p" },
      },
      onClick: (c) => c.setUrl("https://loja-exemplo.com.br/vestido-floral/p"),
    });
    const r = await runWith(
      fake,
      liveCheck([
        { op: "open" },
        { op: "observe_click", target: TITLE },
        { op: "inspect", target: TITLE },
      ]),
    );
    expect(r.outcome).toBe("nao_decidiu");
    // The navigation is on the last line (why it stopped), which the cut keeps.
    const last = r.observed.split("\n").at(-1) ?? "";
    expect(last).toContain("navegou de");
    expect(last).toContain("href=/vestido-floral/p");
    expect(r.observed).not.toContain("inspect");
    expect(fake.calls.clicks).toBe(1);
  });

  test("a slow navigation (requested, not finished) also ends it", async () => {
    const fake = fakePage({
      facts: { [TITLE_SEL]: {}, [HIT]: {} },
      onClick: (c) => c.emitNavigation("https://loja-exemplo.com.br/lento/p"),
    });
    const r = await runWith(
      fake,
      liveCheck([
        { op: "open" },
        { op: "observe_click", target: TITLE },
        { op: "inspect", target: TITLE },
      ]),
    );
    expect(r.outcome).toBe("nao_decidiu");
    expect(r.observed).toContain("https://loja-exemplo.com.br/lento/p");
    expect(r.observed).not.toContain("inspect");
  });

  test("an observe_click with no effect: nao_decidiu with 'nada mudou' and goes on", async () => {
    const fake = fakePage({ facts: { [TITLE_SEL]: {}, [HIT]: {} } });
    const r = await runWith(
      fake,
      liveCheck([
        { op: "open" },
        { op: "observe_click", target: TITLE },
        { op: "inspect", target: TITLE },
      ]),
    );
    expect(r.outcome).toBe("nao_decidiu");
    expect(r.observed).toContain("nada mudou");
    expect(r.observed).toContain("inspect");
    // Scrolls, waits, hit-tests, reads the "before" and clicks, in that order.
    const t = fake.calls.timeline;
    const at = (name: string) => t.indexOf(name);
    expect(at("scrollToCenterInPage")).toBeGreaterThan(-1);
    expect(at("scrollToCenterInPage")).toBeLessThan(at("clickPointInPage"));
    expect(at("clickPointInPage")).toBeLessThan(at("clickSnapshotInPage"));
    expect(at("clickSnapshotInPage")).toBeLessThan(at("click"));
  });

  test("a link opening another tab: says so and does not click", async () => {
    const blank = {
      inLink: true,
      href: "/vestido-floral/p",
      linkTarget: "_blank",
    };
    const fake = fakePage({ facts: { [TITLE_SEL]: blank, [HIT]: blank } });
    const r = await runWith(
      fake,
      liveCheck([
        { op: "open" },
        { op: "observe_click", target: TITLE },
        { op: "inspect", target: TITLE },
      ]),
    );
    expect(r.outcome).toBe("nao_decidiu");
    expect(r.observed).toContain("abre em outra aba");
    expect(r.observed).not.toContain("nada mudou");
    expect(r.observed).toContain("inspect");
    expect(fake.calls.clicks).toBe(0);
  });

  test("a window-name target is another tab too: does not click", async () => {
    const named = { inLink: true, href: "/x/p", linkTarget: "produto" };
    const fake = fakePage({ facts: { [TITLE_SEL]: named, [HIT]: named } });
    const r = await runWith(
      fake,
      liveCheck([{ op: "open" }, { op: "click", target: TITLE }]),
    );
    expect(r.observed).toContain("abre em outra aba");
    expect(fake.calls.clicks).toBe(0);
  });

  test("target _self clicks normally", async () => {
    const self = { inLink: true, href: "/x/p", linkTarget: "_self" };
    const fake = fakePage({ facts: { [TITLE_SEL]: self, [HIT]: self } });
    await runWith(
      fake,
      liveCheck([{ op: "open" }, { op: "click", target: TITLE }]),
    );
    expect(fake.calls.clicks).toBe(1);
  });

  test("reports blocked tracking requests at the start of the report", async () => {
    const fake = fakePage({
      facts: { [TITLE_SEL]: {}, [HIT]: {} },
      blocked: 2,
    });
    const r = await runLiveCheck({
      browser: NO_BROWSER,
      capture: fullCapture,
      check: liveCheck([
        { op: "open" },
        // A report over the cap: the cut is in the middle, the line stays.
        ...Array.from({ length: 20 }, () => ({
          op: "inspect" as const,
          target: TITLE,
        })),
      ]),
      elementKeys: ["r#0|1"],
      media: NO_MEDIA,
      keyPrefix: "ux/d1/verify/h1",
      io: {
        openPage: async (_b, _u, _d, opts) => {
          expect(
            opts.blockRequest?.("https://www.google-analytics.com/g/collect"),
          ).toBe(true);
          return fake.page;
        },
        sleep: async () => {},
      },
    });
    expect(r.observed.length).toBeLessThanOrEqual(1200);
    expect(r.observed).toContain("…");
    expect(r.observed.split("\n")[0]).toBe("bloqueei 2 pedidos de rastreio");
  });

  test("choose_size clicks through the same lock: a forbidden option is not clicked", async () => {
    const fake = fakePage({
      facts: {
        "[data-ux-choice]": { tag: "button", type: "submit", text: "P" },
        [HIT]: { tag: "button", type: "submit", text: "P" },
      },
    });
    const r = await runWith(
      fake,
      liveCheck([{ op: "open" }, { op: "choose_size" }]),
    );
    expect(r.outcome).toBe("nao_testou");
    expect(r.observed).toContain("clicar aqui mexeria na loja");
    expect(fake.calls.clicks).toBe(0);
  });

  test("keep_overlays: the page opens and reloads without closing the pop-up", async () => {
    const fake = fakePage({ facts: {} });
    const opened: Array<boolean | undefined> = [];
    const r = await runLiveCheck({
      browser: NO_BROWSER,
      capture: fullCapture,
      check: liveCheck([
        { op: "open", keep_overlays: true },
        { op: "reload", keep_overlays: true },
      ]),
      elementKeys: ["r#0|1"],
      media: NO_MEDIA,
      keyPrefix: "ux/d1/verify/h1",
      io: {
        openPage: async (_b, _u, _d, opts) => {
          opened.push(opts.keepOverlays);
          return fake.page;
        },
        sleep: async () => {},
      },
    });
    expect(r.outcome).toBe("nao_decidiu");
    expect(opened).toEqual([true]);
    expect(fake.calls.evaluated).not.toContain(dismissOverlaysInPage);
  });

  test("without keep_overlays: opens as usual and the reload closes the pop-up", async () => {
    const fake = fakePage({ facts: {} });
    const opened: Array<boolean | undefined> = [];
    await runLiveCheck({
      browser: NO_BROWSER,
      capture: fullCapture,
      check: liveCheck([{ op: "open" }, { op: "reload" }]),
      elementKeys: ["r#0|1"],
      media: NO_MEDIA,
      keyPrefix: "ux/d1/verify/h1",
      io: {
        openPage: async (_b, _u, _d, opts) => {
          opened.push(opts.keepOverlays);
          return fake.page;
        },
        sleep: async () => {},
      },
    });
    expect(opened).toEqual([false]);
    expect(fake.calls.evaluated).toContain(dismissOverlaysInPage);
  });

  // Some pop-ups open only on the first mousemove/touchmove.
  test("gesture moves the mouse in the middle of the screen and never clicks or touches", async () => {
    const fake = fakePage({ facts: {} });
    const r = await runWith(
      fake,
      liveCheck([
        { op: "open", keep_overlays: true },
        { op: "gesture" },
        { op: "wait", ms: 8000 },
      ]),
    );
    expect(r.outcome).toBe("nao_decidiu");
    expect(r.observed).toContain("gesture: mexi o mouse na página");
    const moves = fake.calls.pointer.filter((c) => c.startsWith("move "));
    expect(moves.length).toBeGreaterThanOrEqual(3);
    for (const m of moves) {
      const [x, y] = m.slice(5).split(",").map(Number);
      expect(x).toBeGreaterThan(390 * 0.2);
      expect(x).toBeLessThan(390 * 0.8);
      expect(y).toBeGreaterThan(844 * 0.3);
      expect(y).toBeLessThan(844 * 0.7);
    }
    expect(fake.calls.clicks).toBe(0);
    expect(fake.calls.pointer.every((c) => c.startsWith("move "))).toBe(true);
    for (const forbidden of [
      "down",
      "up",
      "touchMove",
      "touchStart",
      "touchEnd",
      "tap",
    ]) {
      expect(fake.calls.pointer).not.toContain(forbidden);
    }
  });

  test("performGesture only moves the mouse, through the middle of the screen", async () => {
    const calls: string[] = [];
    await performGesture(
      {
        mouseMove: async (x: number, y: number) => {
          calls.push(`move ${x},${y}`);
        },
      },
      { width: 390, height: 844 },
    );
    expect(calls.length).toBe(GESTURE_PATH.length);
    expect(calls.every((c) => c.startsWith("move "))).toBe(true);
  });

  test("an error marking the anchors goes into the report", async () => {
    const fake = fakePage({ throwOn: elementLabelsInPage, facts: {} });
    const r = await runWith(fake, liveCheck([{ op: "open" }]));
    expect(r.observed).toContain("explodiu");
  });
});

// ── clickSnapshotInPage with a minimal DOM ───────────────────────────────────

describe("clickSnapshotInPage", () => {
  const withDom = (parentHtml: string) => {
    const g = globalThis as Record<string, unknown>;
    const saved = {
      document: g.document,
      location: g.location,
      window: g.window,
    };
    g.document = {
      querySelector: () => ({ parentElement: { outerHTML: parentHtml } }),
      querySelectorAll: () => [],
      activeElement: null,
    };
    g.location = { href: "https://loja-exemplo.com.br/p" };
    g.window = { getSelection: () => "" };
    try {
      return clickSnapshotInPage("[data-ux-anchor]");
    } finally {
      Object.assign(g, saved);
    }
  };

  test("data-ux-* marks do not change the hash", () => {
    const clean = withDom('<div class="a"><h1>Vestido</h1></div>');
    const marked = withDom(
      '<div class="a" data-ux-hit="1"><h1 data-ux-anchor="r#0|1" data-ux-choice="1">Vestido</h1></div>',
    );
    expect(marked.nearHtmlHash).toBe(clean.nearHtmlHash);
  });

  test("a real change changes the hash", () => {
    const a = withDom('<div class="a"><h1>Vestido</h1></div>');
    const b = withDom('<div class="a open"><h1>Vestido</h1></div>');
    expect(a.nearHtmlHash).not.toBe(b.nearHtmlHash);
  });
});

// ── elementFactsInPage: the link's effective target ──────────────────────────

describe("elementFactsInPage linkTarget", () => {
  const facts = (target: string | null, baseTarget: string | null) => {
    const g = globalThis as Record<string, unknown>;
    const saved = {
      document: g.document,
      window: g.window,
      getComputedStyle: g.getComputedStyle,
    };
    const link = {
      getAttribute: (n: string) =>
        n === "href" ? "/x/p" : n === "target" ? target : null,
      hasAttribute: (n: string) => n === "target" && target !== null,
      innerText: "Vestido",
    };
    const el = {
      localName: "span",
      innerText: "Vestido",
      parentElement: null,
      onclick: null,
      closest: (sel: string) =>
        sel.includes("a[href]") && !sel.startsWith("button") ? link : null,
      getAttribute: () => null,
      hasAttribute: () => false,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    };
    const base =
      baseTarget === null
        ? null
        : { getAttribute: (n: string) => (n === "target" ? baseTarget : null) };
    g.document = {
      querySelector: (sel: string) => (sel === "base[target]" ? base : el),
    };
    g.window = { scrollX: 0, scrollY: 0 };
    g.getComputedStyle = () => ({
      cursor: "pointer",
      color: "rgb(0, 0, 0)",
      textDecorationLine: "none",
    });
    try {
      return elementFactsInPage("[data-ux-anchor]");
    } finally {
      Object.assign(g, saved);
    }
  };

  test("the link's own target", () => {
    expect(facts("_blank", null).linkTarget).toBe("_blank");
  });

  test("a link without target inherits the document's <base target>", () => {
    expect(facts(null, "_blank").linkTarget).toBe("_blank");
  });

  test("the link's target (even empty) wins over <base target>", () => {
    expect(facts("", "_blank").linkTarget).toBe("");
    expect(facts("_self", "_blank").linkTarget).toBe("_self");
  });

  test("no target and no base: null", () => {
    expect(facts(null, null).linkTarget).toBeNull();
  });
});

// ── Zero-size wrapper ────────────────────────────────────────────────────────

// A pop-up wrapper can measure 390×0 while its fixed child shows: measure the child.
describe("elementFactsInPage: zero-size wrapper", () => {
  type Box = { left: number; top: number; width: number; height: number };
  type Fake = {
    rect: Box;
    style: Record<string, string>;
    cls?: string;
    tag?: string;
    /** Element.checkVisibility (absent = a browser without it). */
    checkVisibility?: () => boolean;
  };
  const withEdges = (r: Box) => ({
    ...r,
    right: r.left + r.width,
    bottom: r.top + r.height,
  });
  const run = (
    own: Box,
    kids: Fake[],
    ownStyle: Record<string, string> = {},
  ) => {
    const g = globalThis as Record<string, unknown>;
    const saved = {
      document: g.document,
      window: g.window,
      getComputedStyle: g.getComputedStyle,
    };
    const styles = new Map<unknown, Record<string, string>>();
    const parent = { id: "parent", parentElement: null };
    const el = {
      localName: "div",
      id: "NewsletterPopup",
      nodeType: 1,
      firstChild: null,
      nextSibling: null,
      parentElement: parent,
      onclick: null,
      closest: () => null,
      getAttribute: () => null,
      hasAttribute: () => false,
      getBoundingClientRect: () => withEdges(own),
      querySelectorAll: () => children,
    };
    const children = kids.map((f) => {
      const node = {
        localName: f.tag ?? "div",
        id: "",
        parentElement: el,
        getAttribute: (n: string) => (n === "class" ? (f.cls ?? null) : null),
        getBoundingClientRect: () => withEdges(f.rect),
        ...(f.checkVisibility ? { checkVisibility: f.checkVisibility } : {}),
      };
      styles.set(node, f.style);
      return node;
    });
    styles.set(el, {
      cursor: "auto",
      color: "rgb(0, 0, 0)",
      display: "flex",
      ...ownStyle,
    });
    styles.set(parent, { color: "rgb(255, 255, 255)" });
    g.document = {
      querySelector: () => el,
      documentElement: { scrollWidth: 390, scrollHeight: 5000 },
    };
    g.window = { scrollX: 0, scrollY: 100, innerWidth: 390, innerHeight: 844 };
    g.getComputedStyle = (n: unknown) => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      position: "static",
      overflow: "visible",
      overflowX: "visible",
      overflowY: "visible",
      cursor: "auto",
      color: "rgb(0, 0, 0)",
      textDecorationLine: "none",
      ...styles.get(n),
    });
    try {
      return elementFactsInPage("#NewsletterPopup");
    } finally {
      Object.assign(g, saved);
    }
  };
  const visible = { display: "flex", visibility: "visible", opacity: "1" };
  const SCREEN = { left: 0, top: 0, width: 390, height: 844 };

  test("measures the largest visible child (fixed included) and says so", () => {
    const f = run({ left: 0, top: 4097, width: 390, height: 0 }, [
      {
        rect: { left: 0, top: 0, width: 390, height: 900 },
        style: { ...visible, display: "none" },
      },
      {
        rect: SCREEN,
        style: { ...visible, position: "fixed", color: "rgb(255, 0, 0)" },
        cls: "fixed top-0 left-0 right-0",
      },
      {
        rect: { left: 10, top: 162, width: 371, height: 521 },
        style: visible,
      },
      { rect: SCREEN, style: { ...visible, opacity: "0" } },
    ]);
    expect(f.rect).toEqual({ x: 0, y: 100, width: 390, height: 844 });
    expect(f.color).toBe("#ff0000");
    expect(f.wrapper).toEqual({
      width: 390,
      height: 0,
      child: "div.fixed.top-0…",
    });
    expect(f.tag).toBe("div");
    expect(describeFacts(f)).toContain(
      "o alvo é um invólucro 390×0; medi o filho visível div.fixed.top-0… 390×844",
    );
  });

  test("a closed accordion (height:0 overflow:hidden): does not descend", () => {
    const f = run(
      { left: 0, top: 1200, width: 390, height: 0 },
      [
        {
          rect: { left: 0, top: 1200, width: 390, height: 300 },
          style: visible,
        },
      ],
      { overflow: "hidden", overflowX: "hidden", overflowY: "hidden" },
    );
    expect(f.wrapper).toBeNull();
    expect(f.rect?.height).toBe(0);
  });

  test("a fixed child escapes the wrapper's overflow:hidden: descends", () => {
    const f = run(
      { left: 0, top: 1200, width: 390, height: 0 },
      [{ rect: SCREEN, style: { ...visible, position: "fixed" } }],
      { overflow: "hidden", overflowX: "hidden", overflowY: "hidden" },
    );
    expect(f.rect?.height).toBe(844);
    expect(f.wrapper?.height).toBe(0);
  });

  test("checkVisibility refuses: does not count, even with a visible style", () => {
    const f = run({ left: 0, top: 0, width: 0, height: 0 }, [
      { rect: SCREEN, style: visible, checkVisibility: () => false },
    ]);
    expect(f.wrapper).toBeNull();
  });

  test("a child off the document (left:-9999) does not count", () => {
    const f = run({ left: 0, top: 0, width: 0, height: 0 }, [
      {
        rect: { left: -9999, top: 0, width: 300, height: 300 },
        style: visible,
      },
    ]);
    expect(f.wrapper).toBeNull();
  });

  test("a target with size: nothing changes", () => {
    const f = run({ left: 0, top: 10, width: 300, height: 40 }, [
      { rect: SCREEN, style: visible },
    ]);
    expect(f.rect).toEqual({ x: 0, y: 110, width: 300, height: 40 });
    expect(f.wrapper).toBeNull();
  });

  test("a wrapper with no visible child keeps the zero size, with no note", () => {
    const f = run({ left: 0, top: 0, width: 0, height: 0 }, [
      { rect: SCREEN, style: { ...visible, visibility: "hidden" } },
    ]);
    expect(f.rect?.height).toBe(0);
    expect(f.wrapper).toBeNull();
  });

  test("inspect and screenshot on the wrapper report the child; the click stays on the target", async () => {
    const wrapper = { width: 390, height: 0, child: "div.fixed.top-0…" };
    const rect = { x: 0, y: 0, width: 390, height: 844 };
    const fake = fakePage({
      facts: { [TITLE_SEL]: { wrapper, rect }, [HIT]: {} },
    });
    const clips: unknown[] = [];
    const r = await runLiveCheck({
      browser: NO_BROWSER,
      capture: fullCapture,
      check: liveCheck([
        { op: "open", keep_overlays: true },
        { op: "inspect", target: TITLE },
        { op: "screenshot", target: TITLE },
        { op: "observe_click", target: TITLE },
      ]),
      elementKeys: ["r#0|1"],
      media: NO_MEDIA,
      keyPrefix: "ux/d1/verify/h1",
      io: {
        openPage: async () => fake.page,
        sleep: async () => {},
        screenshotClip: async (_p, clip) => {
          clips.push(clip);
          return new Uint8Array();
        },
        storeImage: async () => "https://x/shot.jpg",
      },
    });
    const note =
      "o alvo é um invólucro 390×0; medi o filho visível div.fixed.top-0… 390×844";
    expect(r.observed).toContain(`inspect`);
    expect(r.observed.split(note).length - 1).toBe(3);
    expect(clips).toEqual([{ x: 0, y: 0, width: 390, height: 844 }]);
    // The click uses the target's own hit test (clickPointInPage).
    expect(fake.calls.evaluated).toContain(clickPointInPage);
    expect(fake.calls.clicks).toBe(1);
  });
});

// ── Parts measured again on the check's page ─────────────────────────────────

const PART_RECO = { kind: "part", part: "first_recommendation" } as const;
const PART_SHIP = { kind: "part", part: "shipping" } as const;

const measured = (
  selectors: Record<string, string | null>,
  positions: Record<string, number | null> = {},
) => ({ selectors, positions });

describe("selectorCandidates", () => {
  test("a part: this page's measure first, the capture's as fallback", () => {
    expect(
      selectorCandidates(PART_RECO, capture, {
        first_recommendation: "#shelf > h2",
      }),
    ).toEqual(["#shelf > h2", "h2.reco"]);
  });

  test("with no measure on this page, only the capture's", () => {
    expect(selectorCandidates(PART_RECO, capture, {})).toEqual(["h2.reco"]);
  });

  test("both null: nothing to try", () => {
    expect(selectorCandidates(PART_SHIP, capture, {})).toEqual([]);
  });

  test("equal ones do not repeat", () => {
    expect(
      selectorCandidates(PART_RECO, capture, {
        first_recommendation: "h2.reco",
      }),
    ).toEqual(["h2.reco"]);
  });

  test("an element ignores the measure", () => {
    expect(
      selectorCandidates(TITLE, capture, { first_recommendation: "x" }),
    ).toEqual([TITLE_SEL]);
  });
});

describe("partsOf", () => {
  test("only the parts, without repeats", () => {
    expect(
      partsOf(
        liveCheck([
          { op: "open" },
          { op: "scroll_to", target: PART_RECO },
          { op: "inspect", target: TITLE },
          { op: "screenshot", target: PART_RECO },
          { op: "inspect", target: PART_SHIP },
        ]),
      ),
    ).toEqual(["first_recommendation", "shipping"]);
  });
});

describe("runLiveCheck: parts measured on the check's page", () => {
  test("the capture lacks the part, the page has it: uses it and reports it", async () => {
    const fake = fakePage({
      facts: { "#cep": { tag: "input", text: "CEP" } },
      measured: [measured({ shipping: "#cep" }, { shipping: 1004 })],
    });
    const r = await runWith(
      fake,
      liveCheck([{ op: "open" }, { op: "inspect", target: PART_SHIP }]),
    );
    expect(r.outcome).toBe("nao_decidiu");
    expect(r.observed).toContain(
      "frete: a captura não tinha, achei nesta página em y=1004",
    );
    expect(r.observed).toContain('inspect frete: <input> "CEP"');
  });

  test("this page's measure wins over the capture's", async () => {
    const fake = fakePage({
      facts: {
        "#shelf > h2": { tag: "h2", text: "Complete seu look" },
        "h2.reco": { tag: "h2", text: "título antigo" },
      },
      measured: [measured({ first_recommendation: "#shelf > h2" })],
    });
    const r = await runWith(
      fake,
      liveCheck([{ op: "open" }, { op: "inspect", target: PART_RECO }]),
    );
    expect(r.observed).toContain('"Complete seu look"');
    expect(r.observed).not.toContain("a captura não tinha");
  });

  test("the measure no longer matches: falls back to the capture's", async () => {
    const fake = fakePage({
      facts: { "h2.reco": { tag: "h2", text: "Quem comprou também curtiu" } },
      measured: [measured({ first_recommendation: "#sumiu" })],
    });
    const r = await runWith(
      fake,
      liveCheck([{ op: "open" }, { op: "inspect", target: PART_RECO }]),
    );
    expect(r.observed).toContain('"Quem comprou também curtiu"');
  });

  test("reload measures again", async () => {
    const fake = fakePage({
      facts: { "#novo": { tag: "h2", text: "Depois do reload" } },
      measured: [
        measured({ first_recommendation: null }),
        measured({ first_recommendation: "#novo" }),
      ],
    });
    const r = await runWith(
      fake,
      liveCheck([
        { op: "open" },
        { op: "reload" },
        { op: "inspect", target: PART_RECO },
      ]),
    );
    expect(r.observed).toContain('"Depois do reload"');
    expect(
      fake.calls.timeline.filter((n) => n === "measurePdpInPage"),
    ).toHaveLength(2);
    // The check's measure never scrolls the page (scroll pop-ups, lazy loading).
    expect(fake.calls.measureOpts).toEqual([
      { skipScroll: true },
      { skipScroll: true },
    ]);
  });

  test("a check with no part does not measure (measuring scrolls and costs time)", async () => {
    const fake = fakePage({ facts: { [TITLE_SEL]: {} } });
    await runWith(
      fake,
      liveCheck([{ op: "open" }, { op: "inspect", target: TITLE }]),
    );
    expect(fake.calls.timeline).not.toContain("measurePdpInPage");
  });

  test("the measure breaks: goes on with the capture and says why", async () => {
    const fake = fakePage({
      facts: { "h2.reco": { tag: "h2", text: "Vitrine" } },
      throwOn: measurePdpInPage,
    });
    const r = await runWith(
      fake,
      liveCheck([{ op: "open" }, { op: "inspect", target: PART_RECO }]),
    );
    expect(r.outcome).toBe("nao_decidiu");
    expect(r.observed).toContain("não consegui medir as partes");
    expect(r.observed).toContain('"Vitrine"');
  });
});

// Gallery arrows hidden on mobile (0×0): an empty rectangle's centre lands elsewhere.
describe("isHiddenTarget", () => {
  const facts = (rect: ElementFacts["rect"]) => ({ rect }) as ElementFacts;
  test("0×0 or no rectangle is hidden", () => {
    expect(isHiddenTarget(facts(null))).toBe(true);
    expect(isHiddenTarget(facts({ x: 0, y: 0, width: 0, height: 0 }))).toBe(
      true,
    );
    expect(isHiddenTarget(facts({ x: 0, y: 0, width: 390, height: 1 }))).toBe(
      true,
    );
  });
  test("with area it is visible", () => {
    expect(
      isHiddenTarget(facts({ x: 10, y: 600, width: 40, height: 40 })),
    ).toBe(false);
  });
});
