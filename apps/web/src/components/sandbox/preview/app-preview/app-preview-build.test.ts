import { describe, expect, test } from "bun:test";
import {
  appBuildPointerUrls,
  appPreviewBuildBase,
  fillPreviewLink,
  parseAppBuildPointer,
  toAppBuildSrc,
} from "./app-preview-build";

const ORIGIN = "https://studio.decocms.com";
const BASE = `${ORIGIN}/api/nb/files/app-preview/vir_1/`;
const SHA = "a".repeat(40);
const POINTER = `studio.decocms.com/api/nb/decofile/vir_1/main?token=t.s@${SHA}`;

describe("appPreviewBuildBase", () => {
  test("accepts this Studio's app-preview folder", () => {
    expect(appPreviewBuildBase(BASE, ORIGIN)).toBe(BASE);
  });

  test.each([
    ["a site", "https://www.example.com/"],
    ["another origin", `https://evil.test/api/nb/files/app-preview/vir_1/`],
    ["outside app-preview", `${ORIGIN}/api/nb/files/uploads/x/`],
    ["no trailing slash", `${ORIGIN}/api/nb/files/app-preview/vir_1`],
    ["query", `${BASE}?x=1`],
    ["empty", null],
  ])("ignores %s", (_label, url) => {
    expect(appPreviewBuildBase(url, ORIGIN)).toBeNull();
  });
});

describe("parseAppBuildPointer", () => {
  test("reads a pointer and drops bad optional fields", () => {
    expect(
      parseAppBuildPointer(
        JSON.stringify({ kind: "eitri-app", sha: SHA, pending: "nope" }),
      ),
    ).toEqual({ kind: "eitri-app", sha: SHA });
  });

  test.each([
    ["not json", "{"],
    ["other kind", JSON.stringify({ kind: "site", sha: SHA })],
    ["short sha", JSON.stringify({ kind: "eitri-app", sha: "abc" })],
    [
      "oversized",
      JSON.stringify({ kind: "eitri-app", sha: SHA, x: "a".repeat(5000) }),
    ],
  ])("refuses %s", (_label, body) => {
    expect(parseAppBuildPointer(body)).toBeNull();
  });
});

test("pointer URLs: the branch, then the default branch", () => {
  expect(appBuildPointerUrls(BASE, "feat/a b")).toEqual([
    `${BASE}branches/feat/a%20b.json`,
    `${BASE}default.json`,
  ]);
});

test("toAppBuildSrc keeps the page and every query param", () => {
  const src = toAppBuildSrc(
    `${BASE}${SHA}/studio.html`,
    `${ORIGIN}/calcado?__draft=${encodeURIComponent(POINTER)}&deviceHint=mobile`,
  );
  const url = new URL(src!);
  expect(url.pathname).toBe(
    `/api/nb/files/app-preview/vir_1/${SHA}/studio.html`,
  );
  expect(url.searchParams.get("__path")).toBe("/calcado");
  expect(url.searchParams.get("__draft")).toBe(POINTER);
  expect(url.searchParams.get("deviceHint")).toBe("mobile");
  expect(toAppBuildSrc(`${BASE}${SHA}/studio.html`, null)).toBeNull();
});

describe("fillPreviewLink", () => {
  test("fills an Eitri https link or an allowed scheme", () => {
    expect(fillPreviewLink("https://app.eitri.tech/p?d={draft}", POINTER)).toBe(
      `https://app.eitri.tech/p?d=${encodeURIComponent(POINTER)}`,
    );
    expect(fillPreviewLink("eitri://open?d={draft}", POINTER)).toBe(
      `eitri://open?d=${encodeURIComponent(POINTER)}`,
    );
  });

  test.each([
    ["no slot", "https://app.eitri.tech/p"],
    ["two slots", "https://app.eitri.tech/{draft}/{draft}"],
    ["other https host", "https://evil.test/p?d={draft}"],
    ["lookalike host", "https://eitri.tech.evil.test/p?d={draft}"],
    ["slot in host", "https://{draft}.eitri.tech/"],
    ["userinfo", "https://a@app.eitri.tech/{draft}"],
    ["http", "http://app.eitri.tech/{draft}"],
    ["javascript", "javascript:alert(1)//{draft}"],
    ["intent", "intent://x#{draft}"],
    ["whitespace", "https://app.eitri.tech/ {draft}"],
    ["too long", `https://app.eitri.tech/${"a".repeat(600)}{draft}`],
  ])("refuses %s", (_label, link) => {
    expect(fillPreviewLink(link, POINTER)).toBeNull();
  });

  test("no draft pointer yet, no QR", () => {
    expect(fillPreviewLink("eitri://open?d={draft}", null)).toBeNull();
  });
});
