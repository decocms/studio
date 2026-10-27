import { describe, expect, it } from "bun:test";
import {
  dstBuckets,
  doneBuckets,
  localBucketStart,
  localDayStart,
} from "./order-lake";
import {
  buildDayView,
  BUCKETS_PER_DAY,
  DAYS_AGO,
  type DayAgo,
  type DaySeries,
  evaluateStore,
  type StoreDay,
} from "./order-rules";

const flat = (n: number) => new Array<number>(BUCKETS_PER_DAY).fill(n);

function store(
  today: Partial<DaySeries>,
  ref: Partial<DaySeries> = {},
  overrides: Partial<StoreDay> = {},
): StoreDay {
  const day = (s: Partial<DaySeries>): DaySeries => ({
    placed: s.placed ?? flat(10),
    canceled: s.canceled ?? flat(0.5),
    denied: s.denied ?? flat(0.2),
  });
  const days = Object.fromEntries(
    DAYS_AGO.map((d) => [d, d === 0 ? day(today) : day(ref)]),
  ) as Record<DayAgo, DaySeries>;
  return {
    timezone: "UTC",
    done: 48,
    days,
    firstEventDaysAgo: 60,
    ...overrides,
  };
}

/** `series` with buckets [from, to) replaced by `n`. */
const withDip = (series: number[], from: number, to: number, n: number) =>
  series.map((v, i) => (i >= from && i < to ? n : v));

describe("evaluateStore", () => {
  it("is ok on a normal day", () => {
    const v = evaluateStore(store({}));
    expect(v.orders_drop.status).toBe("ok");
    expect(v.orders_drop.expected).toBe(40);
    expect(v.denied_spike.status).toBe("ok");
    expect(v.cancel_spike.status).toBe("ok");
  });

  it("judges the first hour against the evening before", () => {
    const s = store({});
    // Yesterday's last hour went dark; the reference days' eves did not.
    s.days[1].placed = withDip(flat(10), 92, 96, 0);
    const v = evaluateStore({ ...s, done: 0 });
    expect(v.orders_drop).toMatchObject({ status: "alert", from: -4, to: 0 });
  });

  it("doesn't let a launch hour inflate the hours after it", () => {
    // A 10× hour at 09:00, then a lull at 60 % of normal.
    const placed = withDip(withDip(flat(10), 36, 40, 100), 44, 48, 6);
    const v = evaluateStore(store({ placed }));
    expect(v.orders_drop.level).toBe(1);
    expect(v.orders_drop.status).toBe("ok");
  });

  it("doesn't let one promo day among the references move the baseline", () => {
    const s = store({ placed: withDip(flat(10), 44, 48, 2.5) });
    s.days[7].placed = flat(200);
    const v = evaluateStore(s);
    expect(v.orders_drop.expected).toBe(40);
    expect(v.orders_drop.status).toBe("warning");
  });

  it("doesn't judge a window a DST switch skipped or repeated", () => {
    const v = evaluateStore(
      store({ placed: withDip(flat(10), 44, 48, 0) }, {}, { dstBuckets: [45] }),
    );
    expect(v.orders_drop.status).toBe("low-volume");
    expect(v.cancel_spike.status).toBe("low-volume");
  });

  it("warns, then alerts, as the last hour's orders fall away", () => {
    const warn = evaluateStore(
      store({ placed: withDip(flat(10), 44, 48, 2.5) }),
    );
    expect(warn.orders_drop.status).toBe("warning");
    const outage = evaluateStore(
      store({ placed: withDip(flat(10), 44, 48, 0) }),
    );
    expect(outage.orders_drop.status).toBe("alert");
  });

  it("does not judge a quiet hour", () => {
    const v = evaluateStore(store({ placed: flat(1) }, { placed: flat(1) }));
    expect(v.orders_drop.status).toBe("low-volume");
  });

  it("flags a denial wave against the baseline's denials", () => {
    const v = evaluateStore(store({ denied: withDip(flat(0.2), 44, 48, 5) }));
    // 0.2 a bucket = 0.8 expected; 20 observed.
    expect(v.denied_spike.expected).toBeCloseTo(0.8);
    expect(v.denied_spike.status).toBe("alert");
    expect(v.orders_drop.status).toBe("ok");
  });

  it("expects more cancellations after a campaign hour", () => {
    // 4× the orders at 10:00, and 4× the cancellations an hour later.
    const v = evaluateStore(
      store(
        {
          placed: withDip(flat(10), 40, 44, 40),
          canceled: withDip(flat(2), 44, 48, 8),
        },
        { canceled: flat(2) },
      ),
    );
    expect(v.cancel_spike.expected).toBe(20);
    expect(v.cancel_spike.status).toBe("ok");
  });

  it("never calls fewer than MIN_SPIKE cancellations a spike", () => {
    const v = evaluateStore(
      store({ canceled: withDip(flat(0), 44, 48, 2) }, { canceled: flat(0) }),
    );
    expect(v.cancel_spike.status).toBe("ok");
  });

  it("keeps spikes low-volume until the oldest baseline day has event history", () => {
    const wave = { canceled: withDip(flat(0.5), 44, 48, 10) };
    expect(evaluateStore(store(wave)).cancel_spike.status).toBe("alert");
    for (const firstEventDaysAgo of [null, 28]) {
      const v = evaluateStore(store(wave, {}, { firstEventDaysAgo }));
      expect(v.cancel_spike.status).toBe("low-volume");
      expect(v.denied_spike.status).toBe("low-volume");
    }
  });
});

describe("doneBuckets", () => {
  it("counts buckets that ended at least 5 minutes ago, in the store's zone", () => {
    // 15:04 UTC = 12:04 in São Paulo: 11:45–12:00 ended only 4 min ago.
    expect(
      doneBuckets(new Date("2026-10-19T15:04:00Z"), "America/Sao_Paulo"),
    ).toBe(47);
    expect(
      doneBuckets(new Date("2026-10-19T15:05:00Z"), "America/Sao_Paulo"),
    ).toBe(48);
    expect(
      doneBuckets(new Date("2026-10-19T03:02:00Z"), "America/Sao_Paulo"),
    ).toBe(0);
  });
});

describe("DST", () => {
  it("finds the buckets a switch skipped or repeated today", () => {
    // New York springs forward 02:00 → 03:00 and falls back 02:00 → 01:00.
    expect(
      dstBuckets(new Date("2026-03-08T12:00:00Z"), "America/New_York"),
    ).toEqual([8, 9, 10, 11]);
    expect(
      dstBuckets(new Date("2026-11-01T15:00:00Z"), "America/New_York"),
    ).toEqual([4, 5, 6, 7]);
    expect(
      dstBuckets(new Date("2026-10-19T15:00:00Z"), "America/Sao_Paulo"),
    ).toEqual([]);
  });

  it("starts a 25-hour day at its local midnight", () => {
    expect(
      localDayStart(
        new Date("2026-11-01T15:00:00Z"),
        "America/New_York",
      ).toISOString(),
    ).toBe("2026-11-01T04:00:00.000Z");
  });

  it("agrees with localDayStart on bucket 0 across a switch", () => {
    expect(
      localBucketStart(
        new Date("2026-03-08T12:00:00Z"),
        "America/New_York",
        0,
      ).toISOString(),
    ).toBe(
      localDayStart(
        new Date("2026-03-08T12:00:00Z"),
        "America/New_York",
      ).toISOString(),
    );
  });
});

describe("buildDayView", () => {
  const at = new Date("2026-10-19T12:05:00Z");

  it("projects the rest of the day from today's level", () => {
    // Today runs at 1.5× the baseline; 48 of 96 buckets are done.
    const v = buildDayView(store({ placed: flat(15) }), at);
    expect(v.date).toBe("2026-10-19");
    expect(v.orders.today[11]).toBe(60);
    expect(v.orders.today[12]).toBeNull();
    expect(v.orders.expected[0]).toBe(60);
    expect(v.headline.projected).toBe(48 * 15 + 1.5 * 48 * 10);
    expect(v.headline.d1).toBe(960);
    expect(v.orders.warnAt[0]).toBeCloseTo(18);
    expect(v.verdicts?.orders_drop.timezone).toBe("UTC");
  });

  it("projects from the reference days the lake holds while history loads", () => {
    // Only D-1 is in; W-1..W-4 are empty, which as zeros made the median 0.
    const s = store({});
    for (const d of [7, 14, 21, 28] as const) s.days[d].placed = flat(0);
    const v = buildDayView(s, at);
    expect(v.orders.expected[20]).toBe(40);
    expect(v.headline.projected).toBe(48 * 10 + 48 * 10);
    expect(v.backfill).toBeNull();
  });

  it("leaves days still backfilling out of the baseline", () => {
    // W-1..W-4 have a stray order or two from a half-listed day.
    const s = store(
      {},
      {},
      {
        backfill: { pending: 30, total: 100, days: [7, 14, 21, 28] },
      },
    );
    for (const d of [7, 14, 21, 28] as const) s.days[d].placed = flat(1);
    const v = buildDayView(s, at);
    expect(v.orders.expected[20]).toBe(40);
    expect(v.backfill).toEqual({ pending: 30, total: 100 });
  });

  it("draws no band where the hour is too quiet to judge", () => {
    const v = buildDayView(store({ placed: flat(1) }, { placed: flat(1) }), at);
    expect(v.orders.warnAt.every((b) => b === null)).toBe(true);
  });

  it("falls back to the approximation only for reference days before the install", () => {
    const approximate = Object.fromEntries(
      DAYS_AGO.map((d) => [d, { canceled: flat(2), denied: flat(0) }]),
    );
    const v = buildDayView(
      store({}, {}, { firstEventDaysAgo: 3, approximate }),
      at,
    );
    expect(v.cancellations.approximate).toEqual({
      d1: false,
      w1: true,
      y1: true,
    });
    expect(v.cancellations.canceled.d1[0]).toBe(2); // events: 0.5 × 4
    expect(v.cancellations.canceled.w1[0]).toBe(8); // approximation: 2 × 4
    // No 28 days of history, so no spike band.
    expect(v.cancellations.canceledWarnAt[0]).toBeNull();
  });

  it("splits orders by channel, busiest on D-1 first, so far vs D-1 at the same time", () => {
    const channels = [
      { id: "1", name: null, today: flat(2), d1: flat(1) },
      // The app went dark at 06:00 today; D-1 was its busiest.
      {
        id: "10",
        name: "App",
        today: withDip(flat(3), 24, 96, 0),
        d1: flat(3),
      },
    ];
    const v = buildDayView(store({}, {}, { channels }), at);
    expect(v.channels.map((c) => c.id)).toEqual(["10", "1"]);
    expect(v.channels[0]).toMatchObject({
      name: "App",
      soFar: 72,
      d1SoFar: 144,
    });
    expect(v.channels[0]?.today[5]).toBe(12);
    expect(v.channels[0]?.today[6]).toBe(0);
    expect(v.channels[0]?.today[12]).toBeNull();
    expect(v.channels[1]).toMatchObject({ name: null, soFar: 96, d1SoFar: 48 });
    expect(buildDayView(store({}), at).channels).toEqual([]);
  });
});

it("buildDayView's expected matches the verdict's during an outage", () => {
  const v = buildDayView(
    store({ placed: flat(10).map((n, i) => (i >= 44 && i < 48 ? 0 : n)) }),
    new Date("2026-10-19T12:05:00Z"),
  );
  expect(v.verdicts?.orders_drop.level).toBe(1);
  expect(v.orders.expected[11]).toBe(v.verdicts?.orders_drop.expected);
});
