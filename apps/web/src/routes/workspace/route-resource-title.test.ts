import { describe, expect, test } from "bun:test";
import {
  resolveAgentViewRouteTitle,
  resolveRouteResourceTarget,
} from "./route-resource-title";

describe("resolveAgentViewRouteTitle", () => {
  test("trims a declared title", () => {
    expect(resolveAgentViewRouteTitle("  Sales dashboard  ", "sales")).toBe(
      "Sales dashboard",
    );
  });

  test("falls back to the stable view id for blank and stale views", () => {
    expect(resolveAgentViewRouteTitle("   ", "  sales-dashboard  ")).toBe(
      "sales-dashboard",
    );
    expect(resolveAgentViewRouteTitle(undefined, "stale-view-id")).toBe(
      "stale-view-id",
    );
  });

  test("leaves a malformed blank id to the route's localized fallback", () => {
    expect(resolveAgentViewRouteTitle(undefined, "   ")).toBeUndefined();
  });
});

describe("resolveRouteResourceTarget", () => {
  test("derives a title from the leaf while preserving internal spaces", () => {
    expect(
      resolveRouteResourceTarget(
        "  org-fs:outputs/thread-1/report final.pdf  ",
      ),
    ).toEqual({
      value: "org-fs:outputs/thread-1/report final.pdf",
      title: "report final.pdf",
    });
  });

  test("rejects missing, blank, and directory-shaped payloads", () => {
    expect(resolveRouteResourceTarget(undefined)).toBeNull();
    expect(resolveRouteResourceTarget("   ")).toBeNull();
    expect(resolveRouteResourceTarget("decks/launch/   ")).toBeNull();
  });

  test("lets a route transform its title and fall back when the stem is empty", () => {
    const stripHtmlExtension = (leaf: string) => leaf.replace(/\.html$/i, "");

    expect(
      resolveRouteResourceTarget("decks/Q3 launch.HTML", stripHtmlExtension),
    ).toEqual({ value: "decks/Q3 launch.HTML", title: "Q3 launch" });
    expect(
      resolveRouteResourceTarget("decks/.html", stripHtmlExtension),
    ).toEqual({
      value: "decks/.html",
      title: undefined,
    });
  });
});
