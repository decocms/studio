import { test, expect } from "bun:test";
import { menuItemsFor } from "./toolbar-menu-items";

test("idle → only Start", () => {
  expect(menuItemsFor("idle")).toEqual([{ label: "Start", action: "start" }]);
});

test("starting → empty (Stop lives on the setup tab's right-side controls)", () => {
  expect(menuItemsFor("starting")).toEqual([]);
});

test("running → empty (Stop + Restart live on the setup tab's right-side controls)", () => {
  expect(menuItemsFor("running")).toEqual([]);
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
