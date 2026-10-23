import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { afterEach, describe, expect, test } from "bun:test";
import { hostedPreviewUrls } from "@/components/sandbox/preview/hosted-preview-urls";
import { resolvePreviewDisplay } from "@/components/sandbox/preview/preview-display";
import type { PreviewDeviceSize } from "@/components/sandbox/preview/device-hint";
import { compareDraftLink } from "@/components/thread/repository/cms-publish-compare-path";
import type { PreviewOptions } from "./preview-link";
import {
  getPreviewDraft,
  previewDraftLink,
  previewDraftPageLink,
  previewDraftValue,
  publishPreviewDraft,
  type PreviewDraftModifiers,
} from "./preview-draft-link";

const POINTER = "delivery.decocms.com/sites/acme/drafts/s1.json@e1";
const SITE = "https://www.acme.com";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SCOPE = "org/vm-1";

afterEach(() => publishPreviewDraft(SCOPE, null));

const draftOf = (url: string | null) =>
  url === null ? null : new URL(url).searchParams.get("__draft");

describe("previewDraftValue: the one __draft a hosted preview sends", () => {
  test("the pointer with the forced variants and the preview options", () => {
    const value = previewDraftValue({
      pointer: POINTER,
      forcedVariants: ["pages-home@sections=1"],
      previewOptions: {
        at: "2026-10-23T10:00:00-03:00",
        tests: { hero: true },
      },
    });
    expect(value).toBe(
      "delivery.decocms.com/sites/acme/drafts/s1.json?__variant=pages-home%40sections%3D1&__at=2026-10-23T10%3A00%3A00-03%3A00&__test=hero%3Don@e1",
    );
    expect(
      previewDraftValue({
        pointer: POINTER,
        forcedVariants: [],
        previewOptions: {},
      }),
    ).toBe(POINTER);
  });

  test("never off or a sha for hosted", () => {
    for (const pointer of ["off", SHA, `${SHA}?__at=x`, "no-version"]) {
      expect(
        previewDraftValue({
          pointer,
          forcedVariants: ["a@b=1"],
          previewOptions: { at: "2026-10-23T10:00:00Z" },
        }),
      ).toBeNull();
    }
  });

  test("null pointer → null link", () => {
    expect(
      previewDraftValue({
        pointer: null,
        forcedVariants: [],
        previewOptions: {},
      }),
    ).toBeNull();
    expect(previewDraftLink(`${SITE}/`, null)).toBeNull();
    expect(previewDraftPageLink(SITE, "/", null)).toBeNull();
    expect(previewDraftPageLink(null, "/", POINTER)).toBeNull();
  });
});

/** Every display state a hosted v8 preview can be in. */
const STATES = {
  "pointer still being read": { hostedPointerPending: true, pointer: null },
  "pointer read": { hostedPointerPending: false, pointer: POINTER },
  "pointer read after a publish (emptied, new version)": {
    hostedPointerPending: false,
    pointer: "delivery.decocms.com/sites/acme/drafts/s1.json@e2",
  },
  "no draft store (read answered, no pointer)": {
    hostedPointerPending: false,
    pointer: null,
  },
} as const;

const MODIFIERS: PreviewDraftModifiers[] = [
  { forcedVariants: [], previewOptions: {} },
  { forcedVariants: ["pages-home@sections=1"], previewOptions: {} },
  {
    forcedVariants: ["pages-home@sections.0=2", "pages-home@sections=1"],
    previewOptions: {
      at: "2026-12-24T23:00:00-03:00",
      tests: { hero: false },
    } satisfies PreviewOptions,
  },
];
const DEVICES: PreviewDeviceSize[] = ["desktop", "mobile", "tablet"];

describe("the frame and every link carry the same __draft, in every display state", () => {
  for (const [name, state] of Object.entries(STATES)) {
    test(name, () => {
      for (const modifiers of MODIFIERS) {
        for (const device of DEVICES) {
          const display = resolvePreviewDisplay({
            previewState: { kind: "starting" },
            progressStatus: "doing",
            previewServerUrl: SITE,
            fastPreviewActive: true,
            fastPreviewReady: !!state.pointer,
            hostedDraft: true,
            hostedPointerPending: state.hostedPointerPending,
          });
          const urls = hostedPreviewUrls({
            display,
            path: "/products/shoe?color=red",
            pointer: state.pointer,
            device,
            ...modifiers,
          });
          // The frame publishes its modifiers; the links read them back.
          publishPreviewDraft(SCOPE, modifiers);
          const linkValue = previewDraftValue({
            pointer: state.pointer,
            ...getPreviewDraft(SCOPE),
          });
          const publishPreview = previewDraftPageLink(
            SITE,
            "/products/shoe?color=red",
            linkValue,
          );
          const openDraft = state.pointer
            ? compareDraftLink(new URL("/products/shoe", SITE), {
                kind: "pointer",
                pointer: state.pointer,
                ...(linkValue ? { link: linkValue } : {}),
              })
            : null;

          if (!state.pointer) {
            // No pointer: no frame URL from the draft, no links at all.
            expect(urls.frame).toBeNull();
            expect(urls.newTab).toBeNull();
            expect(publishPreview).toBeNull();
            if (state.hostedPointerPending) {
              expect(display).toMatchObject({
                mode: "none",
                showDecidingLoader: true,
              });
            }
            continue;
          }
          expect(display.mode).toBe("production");
          const frame = draftOf(urls.frame);
          expect(frame).toBe(urls.value);
          expect(frame).not.toBe("off");
          expect(draftOf(urls.newTab)).toBe(frame);
          expect(draftOf(publishPreview)).toBe(frame);
          expect(draftOf(openDraft)).toBe(frame);
          // The frame adds only its device hint; the links never carry it.
          expect(new URL(urls.frame!).searchParams.get("deviceHint")).toBe(
            device,
          );
          expect(new URL(urls.newTab!).searchParams.has("deviceHint")).toBe(
            false,
          );
          expect(new URL(urls.newTab!).pathname).toBe("/products/shoe");
          expect(new URL(urls.newTab!).searchParams.get("color")).toBe("red");
        }
      }
    });
  }

  test("once the frame is gone, links carry the bare pointer", () => {
    publishPreviewDraft(SCOPE, MODIFIERS[2]!);
    publishPreviewDraft(SCOPE, null);
    expect(
      previewDraftValue({ pointer: POINTER, ...getPreviewDraft(SCOPE) }),
    ).toBe(POINTER);
  });
});
