import { describe, expect, it } from "bun:test";
import { OVERLAY_TABS } from "@/layouts/main-panel-tabs/tab-id";
import {
  type LegacyThreadDestination,
  type LegacyThreadSearch,
  translateLegacyThreadRoute,
} from "./legacy-route-translation";

const ORG = "acme";
const THREAD = "thr_1";
const PROJECT = "vir_abc";

const translate = (search?: LegacyThreadSearch | null) =>
  translateLegacyThreadRoute({ org: ORG, taskId: THREAD, search });

describe("translateLegacyThreadRoute", () => {
  it("sends a bare legacy thread URL to the project-less chat route", () => {
    expect(translate()).toEqual({
      to: "/$org/chat/{-$project}",
      params: { org: ORG, project: undefined },
      search: { thread: THREAD },
    });
  });

  it("treats an absent search object the same as an empty one", () => {
    expect(translate(null)).toEqual(translate({}));
  });

  it("promotes virtualmcpid to the project path segment", () => {
    expect(translate({ virtualmcpid: PROJECT })).toEqual({
      to: "/$org/chat/{-$project}",
      params: { org: ORG, project: PROJECT },
      search: { thread: THREAD },
    });
  });

  it("reads a blank virtualmcpid as no project", () => {
    expect(translate({ virtualmcpid: "   " }).params.project).toBeUndefined();
  });

  describe("destination tabs", () => {
    const rows: Array<[string, LegacyThreadDestination]> = [
      ["board", "/$org/tasks/{-$project}"],
      ["files", "/$org/library"],
      ["reports", "/$org/reports"],
      ["overview", "/$org/home"],
    ];

    for (const [main, to] of rows) {
      it(`sends main=${main} to ${to}`, () => {
        expect(translate({ main })).toEqual({
          to,
          params: { org: ORG, project: undefined },
          search: { thread: THREAD },
        });
      });

      /** These overlays always showed the ORG-WIDE surface, so carrying the
       *  agent forward would invent a filter the legacy URL never had. */
      it(`drops the project for main=${main}`, () => {
        const target = translate({ main, virtualmcpid: PROJECT });
        expect(target.to).toBe(to);
        expect(target.params.project).toBeUndefined();
        expect(target.search).toEqual({ thread: THREAD });
      });
    }
  });

  describe("per-agent views stay in ?main=", () => {
    for (const main of ["preview", "code", "content", "settings", "git"]) {
      it(`keeps main=${main} on the chat route`, () => {
        expect(translate({ main, virtualmcpid: PROJECT })).toEqual({
          to: "/$org/chat/{-$project}",
          params: { org: ORG, project: PROJECT },
          search: { thread: THREAD, main },
        });
      });
    }

    /** An overlay tab with no destination route of its own. */
    it("keeps main=connect-sources on the chat route", () => {
      expect(OVERLAY_TABS.has("connect-sources")).toBe(true);
      expect(
        translate({ main: "connect-sources", virtualmcpid: PROJECT }),
      ).toEqual({
        to: "/$org/chat/{-$project}",
        params: { org: ORG, project: PROJECT },
        search: { thread: THREAD, main: "connect-sources" },
      });
    });

    it("carries the main=0 closed sentinel through verbatim", () => {
      expect(translate({ main: 0, virtualmcpid: PROJECT })).toEqual({
        to: "/$org/chat/{-$project}",
        params: { org: ORG, project: PROJECT },
        search: { thread: THREAD, main: 0 },
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

  it("carries a board card deep link onto the tasks route", () => {
    expect(translate({ main: "board", task: "DECO-01" })).toEqual({
      to: "/$org/tasks/{-$project}",
      params: { org: ORG, project: undefined },
      search: { thread: THREAD, task: "DECO-01" },
    });
  });

  it("maps the overlay tabs that have a destination route", () => {
    for (const main of ["board", "files", "reports"]) {
      expect(OVERLAY_TABS.has(main)).toBe(true);
      expect(translate({ main }).to).not.toBe("/$org/chat/{-$project}");
    }
  });
});
