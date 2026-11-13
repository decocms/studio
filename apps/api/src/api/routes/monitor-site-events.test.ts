import { describe, expect, it } from "bun:test";
import {
  resolveSiteWindow,
  type RunQuery,
  type SiteWindow,
} from "./monitor-site";
import {
  decodeSiteEventsCursor,
  type EventRow,
  encodeSiteEventsCursor,
  eventsHistogramQuery,
  eventsPageQuery,
  eventsServicesQuery,
  parseSiteEventFilters,
  querySiteEvents,
  SITE_EVENTS_PAGE_SIZE,
  type SiteEventFilters,
  SiteEventsInputError,
  toEvent,
  toHistogram,
} from "./monitor-site-events";

const NOW = Date.parse("2026-10-19T12:34:56.789Z");
const W = resolveSiteWindow("1h", NOW) as SiteWindow;
const NONE: SiteEventFilters = { kinds: [], levels: [], services: [], q: "" };

describe("parseSiteEventFilters", () => {
  it("reads comma lists, trimmed and deduped; absent means every value", () => {
    expect(parseSiteEventFilters({})).toEqual(NONE);
    expect(
      parseSiteEventFilters({
        kinds: "log, span,log",
        levels: "error,,warn",
        services: " a ,b",
        q: "  timeout  ",
      }),
    ).toEqual({
      kinds: ["log", "span"],
      levels: ["error", "warn"],
      services: ["a", "b"],
      q: "timeout",
    });
  });

  it("rejects an unknown kind or level and an oversized query", () => {
    expect(() => parseSiteEventFilters({ kinds: "metric" })).toThrow(
      SiteEventsInputError,
    );
    expect(() => parseSiteEventFilters({ levels: "fatal" })).toThrow(
      SiteEventsInputError,
    );
    expect(() => parseSiteEventFilters({ q: "x".repeat(201) })).toThrow(
      SiteEventsInputError,
    );
  });

  it("caps the services list", () => {
    const services = Array.from({ length: 50 }, (_, i) => `s${i}`).join(",");
    expect(parseSiteEventFilters({ services }).services).toHaveLength(20);
  });
});

describe("cursor", () => {
  it("round-trips", () => {
    const cursor = { t: "1792000000123456789", id: "l9F3A0B" };
    expect(decodeSiteEventsCursor(encodeSiteEventsCursor(cursor))).toEqual(
      cursor,
    );
  });

  it("rejects anything this API didn't write", () => {
    for (const bad of [
      "nope",
      encodeSiteEventsCursor({ t: "1' OR 1=1", id: "l1" }),
      encodeSiteEventsCursor({ t: "1", id: "x'--" }),
      Buffer.from("null").toString("base64url"),
    ]) {
      expect(() => decodeSiteEventsCursor(bad)).toThrow(SiteEventsInputError);
    }
  });
});

describe("tenancy and filters", () => {
  const hostile = "acme' OR 1=1 --";
  const filters: SiteEventFilters = {
    kinds: ["log"],
    levels: ["error"],
    services: ["svc"],
    q: "boom' --",
  };
  const queries = [
    eventsPageQuery(hostile, W, filters, { t: "1", id: "l1" }),
    eventsHistogramQuery(hostile, W, filters),
    eventsServicesQuery(hostile, W, filters),
  ];

  it("scopes both tables to the site's collector stamp, every value bound as a parameter", () => {
    for (const { query, params } of queries) {
      for (const table of ["default.otel_logs", "default.otel_traces"]) {
        expect(query).toContain(table);
      }
      expect(query.match(/ServiceName = \{slug:String\}/g)).toHaveLength(2);
      expect(
        query.match(/ResourceAttributes\['deco.site'\] = \{slug:String\}/g),
      ).toHaveLength(2);
      expect(query).not.toContain(hostile);
      expect(query).not.toContain("boom");
      expect(params.slug).toBe(hostile);
      expect(params.q).toBe("boom' --");
    }
  });

  it("counts levels across every level, and services across every service", () => {
    const [page, histogram, services] = queries.map((q) => q.query) as [
      string,
      string,
      string,
    ];
    expect(page).toContain("level IN {levels:Array(String)}");
    expect(page).toContain("service IN {services:Array(String)}");
    expect(histogram).not.toContain("level IN");
    expect(histogram).toContain("service IN");
    expect(services).toContain("level IN");
    expect(services).not.toContain("service IN");
  });

  it("pages after the cursor only when there is one", () => {
    expect(eventsPageQuery("s", W, NONE, null).query).not.toContain("cursor_t");
    expect(
      eventsPageQuery("s", W, NONE, { t: "5", id: "s1" }).params,
    ).toMatchObject({ cursor_t: "5", cursor_id: "s1" });
  });
});

describe("transforms", () => {
  const row = (over: Partial<EventRow> = {}): EventRow => ({
    kind: "log",
    ts: "1792000000123456789",
    id: "lABC",
    level: "error",
    service: "site",
    message: "boom",
    duration_ms: null,
    trace_id: "",
    span_id: "",
    attributes: { "http.route": "/p" },
    ...over,
  });

  it("maps a row to the wire event (64-bit ns arrive quoted)", () => {
    expect(toEvent(row())).toEqual({
      id: "lABC",
      timestamp: new Date(1792000000123).toISOString(),
      kind: "log",
      level: "error",
      service: "site",
      message: "boom",
      durationMs: null,
      traceId: null,
      spanId: null,
      attributes: { "http.route": "/p" },
    });
    expect(
      toEvent(
        row({
          kind: "span",
          duration_ms: 12.5,
          trace_id: "t",
          span_id: "s",
          attributes: null,
        }),
      ),
    ).toMatchObject({
      durationMs: 12.5,
      traceId: "t",
      spanId: "s",
      attributes: {},
    });
  });

  it("has one bucket per step over the window, empty ones included", () => {
    const first = W.startMs / 1000;
    const hist = toHistogram(
      [
        { t: String(first), level: "error", count: "2" },
        { t: first, level: "ok", count: 3 },
        { t: first + W.stepS * 2, level: "warn", count: 1 },
      ],
      W,
    );
    expect(hist).toHaveLength(60);
    expect(hist[0]).toEqual({
      t: new Date(W.startMs).toISOString(),
      error: 2,
      warn: 0,
      info: 0,
      ok: 3,
      debug: 0,
    });
    expect(hist[1]?.ok).toBe(0);
    expect(hist[2]?.warn).toBe(1);
  });
});

describe("querySiteEvents", () => {
  const rows = (count: number): EventRow[] =>
    Array.from({ length: count }, (_, i) => ({
      kind: "log",
      ts: String(1792000000000000000n - BigInt(i)),
      id: `l${i.toString(16).toUpperCase()}`,
      level: "error",
      service: "site",
      message: `m${i}`,
      duration_ms: null,
      trace_id: "",
      span_id: "",
      attributes: {},
    }));
  /** A warehouse answering each of the three queries by its shape. */
  const warehouse =
    (page: EventRow[], seen: string[] = []): RunQuery =>
    async <T>(query: string) => {
      seen.push(query);
      if (query.includes("GROUP BY t, level"))
        return [
          { t: W.startMs / 1000, level: "error", count: "4" },
          { t: W.startMs / 1000, level: "ok", count: "6" },
        ] as T[];
      if (query.includes("GROUP BY name"))
        return [{ name: "site", count: "10" }] as T[];
      return page as T[];
    };

  it("returns a page, the cursor of its last event, and the counts", async () => {
    const page = await querySiteEvents(
      warehouse(rows(SITE_EVENTS_PAGE_SIZE + 1)),
      "s",
      W,
      NONE,
      null,
    );
    expect(page.events).toHaveLength(SITE_EVENTS_PAGE_SIZE);
    const last = page.events.at(-1)!;
    expect(decodeSiteEventsCursor(page.nextCursor!)).toEqual({
      t: String(1792000000000000000n - BigInt(SITE_EVENTS_PAGE_SIZE - 1)),
      id: last.id,
    });
    expect(page.total).toBe(10);
    expect(page.facets).toEqual({
      levels: { error: 4, warn: 0, info: 0, ok: 6, debug: 0 },
      services: [{ name: "site", count: 10 }],
    });
  });

  it("has no cursor on the last page", async () => {
    const page = await querySiteEvents(warehouse(rows(3)), "s", W, NONE, null);
    expect(page.events).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it("totals only the levels filtered on", async () => {
    const page = await querySiteEvents(
      warehouse([]),
      "s",
      W,
      { ...NONE, levels: ["error"] },
      null,
    );
    expect(page.total).toBe(4);
    expect(page.facets.levels.ok).toBe(6);
  });

  it("skips the counts after a cursor", async () => {
    const seen: string[] = [];
    const page = await querySiteEvents(warehouse(rows(1), seen), "s", W, NONE, {
      t: "1",
      id: "l1",
    });
    expect(seen).toHaveLength(1);
    expect(page.histogram).toEqual([]);
    expect(page.total).toBe(0);
  });
});
