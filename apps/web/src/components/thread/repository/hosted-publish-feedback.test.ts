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
  notifySavedNotPublished,
} from "./hosted-publish-feedback.ts";

const t: TFunction = (key, vars) => interpolate(en[key], vars);

type Shown = {
  id?: string | number;
  title?: unknown;
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
  const cases: [HostedPublishResult, string, boolean][] = [
    [
      { result: "merged", sha: "a".repeat(40), release: "current" },
      "Published",
      false,
    ],
    [
      { result: "merged", sha: "a".repeat(40), release: "created" },
      "Saved, but not published yet",
      true,
    ],
    [
      { result: "merged", sha: "a".repeat(40), release: "none" },
      "Saved, but not published yet",
      true,
    ],
    [{ result: "up-to-date" }, "Nothing to publish", false],
  ];

  for (const [result, title, offersRetry] of cases) {
    test(`${result.result}${"release" in result ? `/${result.release}` : ""} → "${title}"`, () => {
      let retries = 0;
      const before = total();
      notifyHostedPublish(t, result, () => {
        retries++;
      });
      expect(total() - before).toBeLessThanOrEqual(1);
      const toasts = shown();
      expect(toasts).toHaveLength(1);
      expect(toasts[0]!.id).toBe(SITE_EDITOR_PUBLISH_TOAST);
      expect(toasts[0]!.title).toBe(title);
      for (const word of JARGON)
        expect(String(toasts[0]!.title)).not.toMatch(word);
      if (offersRetry) {
        expect(toasts[0]!.action?.label).toBe("Try again");
        toasts[0]!.action!.onClick({ defaultPrevented: false });
        expect(retries).toBe(1);
      } else {
        expect(toasts[0]!.action).toBeUndefined();
      }
    });
  }

  test("a failed Try again replaces the toast, it doesn't stack", () => {
    const retry = () => {};
    const before = total();
    notifyHostedPublish(
      t,
      { result: "merged", sha: "a".repeat(40), release: "created" },
      retry,
    );
    notifySavedNotPublished(t, new HostedPublishError("HTTP 502", null), retry);
    expect(total() - before).toBeLessThanOrEqual(1);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]!.title).toBe("Saved, but not published yet");
  });
});

describe("hosted Publish: the dialog's error", () => {
  test("someone else published meanwhile", () => {
    const failure = hostedPublishFailure(
      t,
      new HostedPublishError("main-moved", "main-moved"),
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
