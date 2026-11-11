import { expect, test } from "bun:test";
import { cmsRequestSignal } from "./request-deadline";

test("a stalled CMS request reaches its deadline", async () => {
  const signal = cmsRequestSignal(undefined, 5);
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  expect(signal.aborted).toBe(true);
  expect(signal.reason.name).toBe("TimeoutError");
});

test("navigation cancellation keeps its reason and does not wait for the deadline", () => {
  const controller = new AbortController();
  const signal = cmsRequestSignal(controller.signal);
  controller.abort("navigated away");
  expect(signal.aborted).toBe(true);
  expect(signal.reason).toBe("navigated away");
});

test("a request whose caller already cancelled is never revived", () => {
  const controller = new AbortController();
  controller.abort("cancelled");
  expect(cmsRequestSignal(controller.signal).aborted).toBe(true);
});
