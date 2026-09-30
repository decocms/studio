import { describe, expect, it } from "bun:test";
import {
  createOverlaySync,
  diffDecofile,
  snapshotDecofile,
  type OverlayPatch,
} from "./overlay-sync";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("diffDecofile", () => {
  it("sends only changed and new blocks, and deletes missing ones", () => {
    const sent = snapshotDecofile({ a: { x: 1 }, b: { y: 2 }, c: { z: 3 } });
    const { patch } = diffDecofile(sent, {
      a: { x: 1 },
      b: { y: 9 },
      d: { w: 4 },
    });
    expect(patch).toEqual({ set: { b: { y: 9 }, d: { w: 4 } }, delete: ["c"] });
  });

  it("returns null when nothing changed", () => {
    const sent = snapshotDecofile({ a: { x: [1, 2] } });
    expect(diffDecofile(sent, { a: { x: [1, 2] } }).patch).toBeNull();
  });

  it("handles empty baselines and empty next states", () => {
    expect(diffDecofile(new Map(), {}).patch).toBeNull();
    expect(diffDecofile(snapshotDecofile({ a: {} }), {}).patch).toEqual({
      delete: ["a"],
    });
  });

  it("treats undefined values as missing", () => {
    const sent = snapshotDecofile({ a: {} });
    expect(diffDecofile(sent, { a: undefined }).patch).toEqual({
      delete: ["a"],
    });
  });
});

describe("createOverlaySync", () => {
  it("sends nothing until an edit differs from the baseline", async () => {
    const sync = createOverlaySync(0);
    const sent: OverlayPatch[] = [];
    sync.start(
      { a: { x: 1 } },
      async (p) => void sent.push(p),
      () => {},
    );
    sync.update({ a: { x: 1 } });
    await wait(5);
    expect(sent).toEqual([]);
  });

  it("debounces bursts into one patch", async () => {
    const sync = createOverlaySync(10);
    const sent: OverlayPatch[] = [];
    sync.start(
      { a: { x: 1 } },
      async (p) => void sent.push(p),
      () => {},
    );
    sync.update({ a: { x: 2 } });
    sync.update({ a: { x: 3 } });
    await wait(30);
    expect(sent).toEqual([{ set: { a: { x: 3 } } }]);
  });

  it("keeps one request in flight and sends the newest diff after it", async () => {
    const sync = createOverlaySync(0);
    const sent: OverlayPatch[] = [];
    let release = () => {};
    let active = 0;
    let maxActive = 0;
    sync.start(
      { a: { x: 1 } },
      async (p) => {
        active++;
        maxActive = Math.max(maxActive, active);
        sent.push(p);
        if (sent.length === 1) await new Promise<void>((r) => (release = r));
        active--;
      },
      () => {},
    );
    sync.update({ a: { x: 2 } });
    await wait(5);
    sync.update({ a: { x: 3 } });
    await wait(5);
    sync.update({ a: { x: 4 }, b: {} });
    await wait(5);
    expect(sent.length).toBe(1);
    release();
    await wait(5);
    expect(maxActive).toBe(1);
    expect(sent).toEqual([
      { set: { a: { x: 2 } } },
      { set: { a: { x: 4 }, b: {} } },
    ]);
  });

  it("retries failed blocks with the next edit and reports the error", async () => {
    const sync = createOverlaySync(0);
    const sent: OverlayPatch[] = [];
    const errors: unknown[] = [];
    let fail = true;
    sync.start(
      { a: {} },
      async (p) => {
        sent.push(p);
        if (fail) throw new Error("413");
      },
      (e) => errors.push(e),
    );
    sync.update({ a: { big: true } });
    await wait(5);
    fail = false;
    sync.update({ a: { big: true }, b: {} });
    await wait(5);
    expect(errors.length).toBe(1);
    expect(sent[1]).toEqual({ set: { a: { big: true }, b: {} } });
  });

  it("stops sending after stop()", async () => {
    const sync = createOverlaySync(0);
    const sent: OverlayPatch[] = [];
    sync.start(
      {},
      async (p) => void sent.push(p),
      () => {},
    );
    sync.update({ a: {} });
    sync.stop();
    sync.update({ b: {} });
    await wait(5);
    expect(sent).toEqual([]);
  });
});
