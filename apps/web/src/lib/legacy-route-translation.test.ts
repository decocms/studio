import { describe, expect, it } from "bun:test";
import { OVERLAY_TABS } from "@/layouts/main-panel-tabs/tab-id";
import { formatPinnedViewTabId } from "@/layouts/main-panel-tabs/tab-id";
import {
  type LegacyThreadDestination,
  type LegacyThreadSearch,
  promoteLegacyTaskParam,
  translateLegacyMainParam,
  translateLegacyThreadRoute,
} from "./legacy-route-translation";

const ORG = "acme";
const THREAD = "thr_1";
const PROJECT = "vir_abc";

const translate = (search?: LegacyThreadSearch | null) =>
  translateLegacyThreadRoute({ org: ORG, taskId: THREAD, search });

/** A translated view always clears every panel payload key, so a stale one from
 *  the previous view can never outlive it. */
const CLEARED_PAYLOAD = {
  file: undefined,
  key: undefined,
  deck: undefined,
  path: undefined,
  connection: undefined,
  tool: undefined,
  automation: undefined,
};

describe("translateLegacyThreadRoute", () => {
  it("sends a bare legacy thread URL to the project-less chat route", () => {
    expect(translate()).toEqual({
      to: "/$org/agents/{-$panel}",
      params: { org: ORG, project: undefined, panel: undefined },
      search: { thread: THREAD },
    });
  });

  it("treats an absent search object the same as an empty one", () => {
    expect(translate(null)).toEqual(translate({}));
  });

  it("carries the agent onto the agents route", () => {
    expect(translate({ virtualmcpid: PROJECT })).toEqual({
      to: "/$org/agents/{-$panel}",
      params: { org: ORG, project: PROJECT, panel: undefined },
      search: { thread: THREAD },
    });
  });

  it("reads a blank virtualmcpid as no agent", () => {
    expect(translate({ virtualmcpid: "   " }).params.project).toBeUndefined();
  });

  describe("destination tabs", () => {
    const rows: Array<[string, LegacyThreadDestination]> = [
      ["board", "/$org/tasks/{-$taskKey}"],
      ["files", "/$org/library"],
      ["reports", "/$org/reports"],
      ["overview", "/$org/home"],
    ];

    for (const [main, to] of rows) {
      it(`sends main=${main} to ${to}`, () => {
        expect(translate({ main })).toEqual({
          to,
          params: { org: ORG, project: undefined, panel: undefined },
          search: { thread: THREAD },
        });
      });

      /** These overlays always showed the ORG-WIDE surface, so carrying the
       *  agent forward would invent a filter the legacy URL never had. */
      it(`drops the project for main=${main}`, () => {
        const target = translate({ main, virtualmcpid: PROJECT });
        expect(target.to).toBe(to);
        expect(target.params.project).toBeUndefined();
        expect(target.search).toEqual({
          thread: THREAD,
          main: undefined,
          virtualmcpid: undefined,
          ...CLEARED_PAYLOAD,
        });
      });

      /** The key must be PRESENT-and-undefined, not absent. `virtualmcpid` is
       *  retained across navigation, and retention re-adds a key the next
       *  search omits — so an absent key hands the scope back on a page that
       *  has no project. `toEqual` cannot see this difference; `in` can. */
      it(`writes the dropped scope explicitly for main=${main}`, () => {
        const target = translate({ main, virtualmcpid: PROJECT });
        expect("virtualmcpid" in target.search).toBe(true);
        expect(target.search.virtualmcpid).toBeUndefined();
      });
    }
  });

  describe("per-agent views become the chat route's panel segment", () => {
    for (const main of ["site-editor", "code", "settings", "git"]) {
      it(`makes main=${main} the panel segment`, () => {
        expect(translate({ main, virtualmcpid: PROJECT })).toEqual({
          to: "/$org/agents/{-$panel}",
          params: { org: ORG, project: PROJECT, panel: main },
          search: { thread: THREAD, main: undefined, ...CLEARED_PAYLOAD },
        });
      });
    }

    /** INVERTED. `content` used to become a segment of its own like the rest;
     *  it is a view ON the Site Editor now, so the param it arrives in is the
     *  param it stays in — carried onto that segment rather than retired. */
    it("carries main=content onto the site-editor segment", () => {
      expect(translate({ main: "content", virtualmcpid: PROJECT })).toEqual({
        to: "/$org/agents/{-$panel}",
        params: { org: ORG, project: PROJECT, panel: "site-editor" },
        search: {
          thread: THREAD,
          ...CLEARED_PAYLOAD,
          main: "content",
        },
      });
    });

    /** An overlay tab with no destination route of its own. */
    it("makes main=connect-sources the panel segment", () => {
      expect(OVERLAY_TABS.has("connect-sources")).toBe(true);
      expect(
        translate({ main: "connect-sources", virtualmcpid: PROJECT }),
      ).toEqual({
        to: "/$org/agents/{-$panel}",
        params: { org: ORG, project: PROJECT, panel: "connect-sources" },
        search: { thread: THREAD, main: undefined, ...CLEARED_PAYLOAD },
      });
    });

    /** The shape in already-delivered mail (`tools/reports/setup.ts`). */
    it("splits a pinned-view tab id into the app panel and its payload", () => {
      const target = translate({
        main: formatPinnedViewTabId("conn_1", "get_my_diagnostic"),
        virtualmcpid: PROJECT,
      });
      expect(target.to).toBe("/$org/agents/{-$panel}");
      expect(target.params).toEqual({
        org: ORG,
        project: PROJECT,
        panel: "app",
      });
      expect(target.search).toMatchObject({
        thread: THREAD,
        main: undefined,
        connection: "conn_1",
        tool: "get_my_diagnostic",
      });
    });

    it("turns the main=0 closed sentinel into ?mainpanel=false", () => {
      expect(translate({ main: 0, virtualmcpid: PROJECT })).toEqual({
        to: "/$org/agents/{-$panel}",
        params: { org: ORG, project: PROJECT, panel: undefined },
        search: { thread: THREAD, main: undefined, mainpanel: false },
      });
    });
  });

  it("carries sidepanel and unknown params through verbatim", () => {
    expect(
      translate({
        virtualmcpid: PROJECT,
        sidepanel: false,
        autosend: "hi",
        somethingNobodyDeclared: "x",
      }).search,
    ).toEqual({
      thread: THREAD,
      sidepanel: false,
      autosend: "hi",
      somethingNobodyDeclared: "x",
    });
  });

  /** The card's `?task=` is handed OFF, not translated: the tasks route's own
   *  `beforeLoad` is the single place it is retired (see
   *  `promoteLegacyTaskParam` below), so it must survive this hop intact. */
  it("hands a board card deep link off to the tasks route verbatim", () => {
    expect(translate({ main: "board", task: "DECO-01" })).toEqual({
      to: "/$org/tasks/{-$taskKey}",
      params: { org: ORG, project: undefined, panel: undefined },
      search: { thread: THREAD, task: "DECO-01" },
    });
  });

  it("maps the overlay tabs that have a destination route", () => {
    for (const main of ["board", "files", "reports"]) {
      expect(OVERLAY_TABS.has(main)).toBe(true);
      expect(translate({ main }).to).not.toBe("/$org/agents/{-$panel}");
    }
  });
});

/** The tasks route's search, as far as this rule is concerned. */
interface TasksSearch {
  task?: string;
  view?: string;
  q?: string;
}

describe("promoteLegacyTaskParam", () => {
  it("leaves a URL that names no card alone", () => {
    const filtersOnly: TasksSearch = { view: "list" };
    expect(promoteLegacyTaskParam(undefined, filtersOnly)).toBeNull();
    expect(promoteLegacyTaskParam("DECO-01", filtersOnly)).toBeNull();
  });

  it("moves a legacy `?task=` into the path segment", () => {
    const search: TasksSearch = { task: "board_abc", q: "x" };
    expect(promoteLegacyTaskParam(undefined, search)).toEqual({
      taskKey: "board_abc",
      search: { q: "x" },
    });
  });

  /** The path is the address; `?task=` arriving beside it is a stale echo. */
  it("keeps the segment when both name a card, and drops the echo", () => {
    expect(promoteLegacyTaskParam("DECO-01", { task: "board_abc" })).toEqual({
      taskKey: "DECO-01",
      search: {},
    });
  });

  it("retires a blank `?task=` instead of leaving it unresolvable in the URL", () => {
    expect(promoteLegacyTaskParam(undefined, { task: "  " })).toEqual({
      taskKey: undefined,
      search: {},
    });
  });
});

describe("translateLegacyMainParam", () => {
  it("leaves a URL that carries no ?main= alone", () => {
    expect(translateLegacyMainParam(undefined)).toBeNull();
  });

  it("keeps the closed sentinel on the page it arrived on", () => {
    expect(translateLegacyMainParam(0)).toEqual({
      to: null,
      panel: undefined,
      search: { main: undefined, mainpanel: false },
    });
    expect(translateLegacyMainParam("0")).toEqual(
      translateLegacyMainParam(0) as never,
    );
  });

  it("sends a destination view to its own page", () => {
    expect(translateLegacyMainParam("board")?.to).toBe(
      "/$org/tasks/{-$taskKey}",
    );
    expect(translateLegacyMainParam("files")?.to).toBe("/$org/library");
  });

  /** The retired name is accepted on input and rewritten on output, so a
   *  bookmark minted before the rename lands on the segment that owns the
   *  view rather than on one nothing renders. */
  it("makes a bookmarked ?main=preview the site-editor panel segment", () => {
    expect(translateLegacyMainParam("preview")).toEqual({
      to: "/$org/agents/{-$panel}",
      panel: "site-editor",
      search: { main: undefined, ...CLEARED_PAYLOAD },
    });
  });

  /** The carve-out's other half: once the URL carries both the segment and the
   *  param there is nothing left to retire, so the redirect that produced it
   *  cannot fire on its own output. */
  it("leaves main=content alone once it is on the site-editor segment", () => {
    expect(translateLegacyMainParam("content", "site-editor")).toBeNull();
    expect(translateLegacyMainParam("content")).toEqual({
      to: "/$org/agents/{-$panel}",
      panel: "site-editor",
      search: { ...CLEARED_PAYLOAD, main: "content" },
    });
  });

  /** The same pinned-view grammar, arriving on a DESTINATION rather than on
   *  the legacy thread route — the entry point `<LegacyMainRedirect />` uses.
   *  The payload has to split out here too, or a bookmarked pinned view lands
   *  on the app panel with nothing to render. */
  it("splits a pinned-view tab id on a destination too", () => {
    expect(
      translateLegacyMainParam(formatPinnedViewTabId("conn_1", "get_orders")),
    ).toEqual({
      to: "/$org/agents/{-$panel}",
      panel: "app",
      search: {
        main: undefined,
        ...CLEARED_PAYLOAD,
        connection: "conn_1",
        tool: "get_orders",
      },
    });
  });

  it("migrates the merged settings tabs onto one segment", () => {
    for (const legacy of ["instructions", "connections", "layout"]) {
      expect(translateLegacyMainParam(legacy)?.panel).toBe("settings");
    }
  });
});
