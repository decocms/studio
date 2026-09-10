/**
 * The orphan end that killed a live run: an agent had cloned its repo and was
 * still working in its pod when the reducer threw `Received reasoning-end for
 * missing reasoning part with ID "stream-2"` and tore the Studio-side run down.
 */
import { expect, test } from "bun:test";
import { createOrphanEndGuard } from "./claude-code";

const start = (id: string) => ({ type: "reasoning-start", id });
const end = (id: string) => ({ type: "reasoning-end", id });
const delta = (id: string) => ({ type: "reasoning-delta", id, delta: "x" });

test("a matched start/end pair passes through untouched", () => {
  const guard = createOrphanEndGuard();
  const chunks = [start("a"), delta("a"), end("a")];
  expect(guard(chunks)).toEqual(chunks);
});

test("an end whose start was never emitted is dropped", () => {
  const guard = createOrphanEndGuard();
  expect(guard([end("stream-2")])).toEqual([]);
});

test("finish-step closes every open part, as the reducer does", () => {
  const guard = createOrphanEndGuard();
  guard([start("stream-2")]);
  // The reducer cleared its open parts here; an end after it is an orphan.
  expect(guard([{ type: "finish-step" }, end("stream-2")])).toEqual([
    { type: "finish-step" },
  ]);
});

test("a second end for the same part is dropped", () => {
  const guard = createOrphanEndGuard();
  guard([start("a")]);
  expect(guard([end("a")])).toEqual([end("a")]);
  expect(guard([end("a")])).toEqual([]);
});

test("text parts are tracked independently of reasoning parts", () => {
  const guard = createOrphanEndGuard();
  guard([{ type: "text-start", id: "a" }]);
  // Same id, different kind: the reasoning part was never opened.
  expect(guard([end("a")])).toEqual([]);
  expect(guard([{ type: "text-end", id: "a" }])).toEqual([
    { type: "text-end", id: "a" },
  ]);
});

test("everything that is not a part lifecycle chunk passes through", () => {
  const guard = createOrphanEndGuard();
  const others = [
    { type: "start-step" },
    { type: "tool-input-start", id: "t1" },
    { type: "finish", finishReason: "stop" },
    null,
    "not an object",
  ];
  expect(guard(others)).toEqual(others);
});
