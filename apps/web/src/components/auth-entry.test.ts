import { expect, test } from "bun:test";
import { safeRelativeRedirect } from "./auth-entry";

test("safeRelativeRedirect keeps an ordinary relative path", () => {
  expect(safeRelativeRedirect("/org/home")).toBe("/org/home");
});

test("safeRelativeRedirect blocks a protocol-relative URL", () => {
  expect(safeRelativeRedirect("//evil.com")).toBe("/");
});

test("safeRelativeRedirect blocks the backslash bypass a browser resolves like //", () => {
  expect(new URL("/\\evil.com", "https://app.test").host).toBe("evil.com");
  expect(safeRelativeRedirect("/\\evil.com")).toBe("/");
});

test("safeRelativeRedirect blocks an absolute URL", () => {
  expect(safeRelativeRedirect("https://evil.com")).toBe("/");
});
