import { test, expect } from "bun:test";
import { menuItemsFor } from "./toolbar-menu-items";

test("idle → only Start", () => {
  expect(menuItemsFor("idle")).toEqual([{ label: "Start", action: "start" }]);
});

test("starting → only Stop", () => {
  expect(menuItemsFor("starting")).toEqual([{ label: "Stop", action: "stop" }]);
});

test("running → Stop + Restart, in that order", () => {
  expect(menuItemsFor("running")).toEqual([
    { label: "Stop", action: "stop" },
    { label: "Restart", action: "restart" },
  ]);
});

test("suspended → only Resume", () => {
  expect(menuItemsFor("suspended")).toEqual([
    { label: "Resume", action: "resume" },
  ]);
});

test("errored → only Retry", () => {
  expect(menuItemsFor("errored")).toEqual([
    { label: "Retry", action: "retry" },
  ]);
});
