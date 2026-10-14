import { expect, test } from "bun:test";
import { ConnectionWatch } from "./connection-watch";

test("a disconnected state that recovers before the grace period does not fire", async () => {
  let fired = 0;
  const watch = new ConnectionWatch(() => fired++, 20);
  watch.report("disconnected");
  watch.report("connected");
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(fired).toBe(0);
});

test("a disconnected state that outlasts the grace period fires once", async () => {
  let fired = 0;
  const watch = new ConnectionWatch(() => fired++, 10);
  watch.report("disconnected");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(fired).toBe(1);
});

test("failed and closed fire immediately, bypassing the grace period", () => {
  let fired = 0;
  const watch = new ConnectionWatch(() => fired++, 10_000);
  watch.report("failed");
  expect(fired).toBe(1);
  watch.dispose();
  fired = 0;
  const closedWatch = new ConnectionWatch(() => fired++, 10_000);
  closedWatch.report("closed");
  expect(fired).toBe(1);
});

test("dispose cancels a pending disconnect timer", async () => {
  let fired = 0;
  const watch = new ConnectionWatch(() => fired++, 10);
  watch.report("disconnected");
  watch.dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(fired).toBe(0);
});
