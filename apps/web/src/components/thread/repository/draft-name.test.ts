import { describe, expect, it } from "bun:test";
import type { Release } from "@decocms/shared/sdk/types";
import { en } from "@/i18n/en/index.ts";
import { interpolate } from "@/i18n/interpolate.ts";
import type { TFunction } from "@/i18n/use-t.ts";
import { draftBaseName, nextDraftName } from "./draft-name";

const t: TFunction = (key, vars) => interpolate(en[key], vars);

const rel = (name: string): Release => ({
  branch: name.toLowerCase().replace(/\W+/g, "-"),
  name,
  color: "orange",
});

describe("draftBaseName", () => {
  it("uses the creator's first name", () => {
    expect(draftBaseName(t, "Ana Souza")).toBe("Ana's draft");
  });

  it("keeps an email local-part whole", () => {
    expect(draftBaseName(t, "ana.souza")).toBe("ana.souza's draft");
  });

  it("falls back to the generic name without a usable label", () => {
    expect(draftBaseName(t, undefined)).toBe("Draft");
    expect(draftBaseName(t, null)).toBe("Draft");
    expect(draftBaseName(t, "   ")).toBe("Draft");
  });
});

describe("nextDraftName", () => {
  it("starts with the bare base", () => {
    expect(nextDraftName([], "Ana's draft")).toBe("Ana's draft");
  });

  it("numbers from 2 once the bare base is taken", () => {
    expect(nextDraftName([rel("Ana's draft")], "Ana's draft")).toBe(
      "Ana's draft 2",
    );
  });

  it("goes one above the highest number", () => {
    expect(
      nextDraftName(
        [rel("Ana's draft"), rel("Ana's draft 4"), rel("Ana's draft 2")],
        "Ana's draft",
      ),
    ).toBe("Ana's draft 5");
  });

  it("continues legacy numbered drafts", () => {
    expect(nextDraftName([rel("Draft 1"), rel("Draft 3")], "Draft")).toBe(
      "Draft 4",
    );
  });

  it("ignores renamed drafts and other users' drafts", () => {
    expect(
      nextDraftName(
        [rel("Black Friday"), rel("Bruno's draft"), rel("Ana's draft x")],
        "Ana's draft",
      ),
    ).toBe("Ana's draft");
  });
});
