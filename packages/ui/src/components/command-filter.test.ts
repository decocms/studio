/**
 * The scoring contract every palette built on `Command` depends on.
 *
 * A palette mixes two kinds of row: LOCAL ones cmdk can score from their
 * `value`, and REMOTE ones a server already matched — on text (a task key, a
 * message body) that is never in `value`. Turning `shouldFilter` off to keep
 * the remote rows visible is the trap: it disables scoring for the WHOLE list,
 * so the local rows stop filtering too and every destination and project stays
 * on screen no matter what is typed. `keywords` is the way out — it lets a
 * remote row opt out of scoring without the local rows losing it.
 *
 * These assertions pin that, so a cmdk bump that stops honoring `keywords`
 * fails here instead of silently un-filtering a palette.
 */

import { describe, expect, test } from "bun:test";
import { defaultFilter } from "cmdk";

const score = defaultFilter!;

describe("cmdk default filter", () => {
  test("scores a local row by its value, and drops one that does not match", () => {
    expect(score("Investors", "invest", undefined)).toBeGreaterThan(0);
    expect(score("Home", "invest", undefined)).toBe(0);
  });

  test("keeps every row when nothing is typed", () => {
    expect(score("Home", "", undefined)).toBeGreaterThan(0);
  });

  test("drops a server-matched row whose value lacks the search text", () => {
    // The failure mode: GLOBAL_SEARCH matched this card on its key, which is
    // not in `value`, so cmdk scores it 0 and a found result renders as
    // "No results".
    expect(score("Fix the login bug task_abc", "ENG-42", undefined)).toBe(0);
  });

  test("keeps that same row once the live term is passed as a keyword", () => {
    expect(
      score("Fix the login bug task_abc", "ENG-42", ["ENG-42"]),
    ).toBeGreaterThan(0);
    expect(
      score("Weekly sync notes thr_9", "invest", ["invest"]),
    ).toBeGreaterThan(0);
  });
});
