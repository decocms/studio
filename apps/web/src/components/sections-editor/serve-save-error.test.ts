import { afterEach, describe, expect, test } from "bun:test";
import { ContentProtocolError, ErrorCode } from "@decocms/blocks/protocol";
import { toast } from "sonner";
import { en } from "@/i18n/en/index.ts";
import { interpolate } from "@/i18n/interpolate.ts";
import type { TFunction } from "@/i18n/use-t.ts";
import {
  ServeLostError,
  saveErrorDetail,
  saveErrorMessage,
} from "./serve-save-error";
import {
  SITE_EDITOR_PUBLISH_TOAST,
  SITE_EDITOR_SAVE_TOAST,
  toastPublishFailed,
  toastPublished,
  toastSaveError,
} from "./site-editor-toast";

const t: TFunction = (key, vars) => interpolate(en[key], vars);

const conflict = () =>
  new ContentProtocolError(ErrorCode.Conflict, "a precondition failed");

describe("save messages for business users (hosted, sandbox, legacy)", () => {
  for (const source of ["github", "sandbox", null] as const) {
    test(`${source ?? "legacy"}: plain words, never the server or git`, () => {
      const cases: [Error, RegExp][] = [
        [conflict(), /someone else changed this/],
        [
          new ContentProtocolError(ErrorCode.ReadOnly, "read-only"),
          /can't be edited/,
        ],
        [
          new ContentProtocolError(ErrorCode.LimitExceeded, "too big"),
          /too large/,
        ],
        [new Error("HTTP 502 from api.github.com"), /^Couldn't save/],
        [new ServeLostError(new TypeError("Failed to fetch")), /^Couldn't/],
      ];
      for (const [error, message] of cases) {
        const text = saveErrorMessage(t, error, source);
        expect(text).toMatch(message);
        for (const jargon of [/deco serve/i, /\bgit\b/i, /computer/i]) {
          expect(text).not.toMatch(jargon);
        }
        // The error's own text is never the headline: it goes to Details.
        expect(text).not.toContain(error.message);
        expect(saveErrorDetail(error, source)).toContain(error.message);
      }
    });
  }

  test("a refused block says to fix the fields; Details names them", () => {
    const error = new ContentProtocolError(ErrorCode.InvalidBlock, "invalid", {
      violations: [
        { name: "Header", rule: "required", message: "title is required" },
      ],
    });
    expect(saveErrorMessage(t, error, "github")).toBe(
      "Not saved: some fields aren't filled in correctly. Fix them and try again.",
    );
    expect(saveErrorDetail(error, "github")).toContain("title is required");
  });
});

describe("save messages for a local deco serve (a developer)", () => {
  test("keep naming the server and the error's own text", () => {
    expect(saveErrorMessage(t, conflict(), "local")).toMatch(
      /changed on your computer/,
    );
    expect(saveErrorMessage(t, new Error("disk full"), "local")).toBe(
      "Save failed: disk full",
    );
    expect(saveErrorDetail(new Error("disk full"), "local")).toBeNull();
  });
});

describe("one toast per save failure", () => {
  afterEach(() => {
    toast.dismiss();
  });

  test("a burst of failing autosaves shows a single toast", () => {
    for (let i = 0; i < 3; i++) {
      toastSaveError(t, new Error(`HTTP 50${i}`), "github");
    }
    const shown = toast
      .getToasts()
      .filter((item) => item.id === SITE_EDITOR_SAVE_TOAST);
    expect(shown).toHaveLength(1);
  });
});

describe("one toast per publish", () => {
  afterEach(() => {
    toast.dismiss();
  });

  test("a failure, its retry and the success share one toast", () => {
    let retried = 0;
    toastPublishFailed(t, {
      headline: "Couldn't publish this version.",
      detail: "latest-update-failed",
      retry: () => {
        retried++;
      },
    });
    const failed = toast
      .getToasts()
      .filter((item) => item.id === SITE_EDITOR_PUBLISH_TOAST);
    expect(failed).toHaveLength(1);
    const action = (failed[0] as { action?: { label: string } }).action;
    expect(action?.label).toBe("Try again");
    // The headline never carries the developer detail.
    expect((failed[0] as { title?: unknown }).title).toBe(
      "Couldn't publish this version.",
    );
    toastPublished(t, "This version is live.");
    const shown = toast
      .getToasts()
      .filter((item) => item.id === SITE_EDITOR_PUBLISH_TOAST);
    expect(shown).toHaveLength(1);
    expect((shown[0] as { title?: unknown }).title).toBe("Published");
    // The success doesn't keep the failure's "Try again".
    expect((shown[0] as { action?: unknown }).action).toBeUndefined();
    expect(retried).toBe(0);
  });
});
