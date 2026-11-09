import { describe, expect, test } from "bun:test";
import { toast } from "sonner";
import { en } from "@/i18n/en/index.ts";
import { interpolate } from "@/i18n/interpolate.ts";
import type { TFunction } from "@/i18n/use-t.ts";
import { SITE_EDITOR_PUBLISH_TOAST } from "@/components/sections-editor/site-editor-toast.tsx";
import {
  HostedPublishError,
  type HostedPublishResult,
} from "./hosted-publish-api.ts";
import {
  hostedPublishFailure,
  notifyHostedPublish,
} from "./hosted-publish-feedback.ts";

const t: TFunction = (key, vars) => interpolate(en[key], vars);

type Shown = {
  id?: string | number;
  title?: unknown;
  description?: unknown;
  type?: string;
  action?: { label: string; onClick: (event: unknown) => void };
};
/** The publish toast(s) on screen. Sonner's state is global and outlives a
 *  test, so "one toast" is: one with the publish id, and at most one new. */
const shown = () =>
  (toast.getToasts() as Shown[]).filter(
    (item) => item.id === SITE_EDITOR_PUBLISH_TOAST,
  );
const total = () => toast.getToasts().length;

const JARGON = [/\bCDN\b/i, /merged?/i, /\bcurrent\b/i, /\bmain\b/i, /commit/i];

describe("hosted Publish: one toast per Publish", () => {
  const cases: [HostedPublishResult, string][] = [
    [
      {
        result: "merged",
        sha: "fe6c5e0d97ff-0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a55",
      },
      "Published. Your site will show it shortly.",
    ],
    [{ result: "up-to-date" }, "Nothing to publish"],
  ];

  for (const [result, title] of cases) {
    test(`${result.result} → "${title}"`, () => {
      const before = total();
      notifyHostedPublish(t, result);
      expect(total() - before).toBeLessThanOrEqual(1);
      const toasts = shown();
      expect(toasts).toHaveLength(1);
      expect(toasts[0]!.id).toBe(SITE_EDITOR_PUBLISH_TOAST);
      expect(toasts[0]!.title).toBe(title);
      for (const word of JARGON)
        expect(String(toasts[0]!.title)).not.toMatch(word);
      // A publish toast never says "live": the site shows it shortly.
      expect(String(toasts[0]!.title)).not.toMatch(/live/i);
      expect(String(toasts[0]!.description ?? "")).not.toMatch(/live/i);
      // Live once it answers: no "Try again".
      expect(toasts[0]!.action).toBeUndefined();
    });
  }
});

describe("hosted Publish: the dialog's error", () => {
  test("someone else published meanwhile", () => {
    const failure = hostedPublishFailure(
      t,
      new HostedPublishError("production moved", "production_moved"),
    );
    expect(failure.message).toMatch(/Someone else published/);
    expect(failure.detail).toBeNull();
  });

  test("any other failure: plain words, the API's text only in Details", () => {
    for (const raw of [
      "hosted delivery not configured",
      "Project has no repository",
      "HTTP 500",
    ]) {
      const failure = hostedPublishFailure(t, new HostedPublishError(raw, raw));
      expect(failure.message).toBe(
        "Couldn't publish. Your changes are saved. Try again in a moment.",
      );
      expect(failure.detail).toBe(raw);
    }
  });
});
