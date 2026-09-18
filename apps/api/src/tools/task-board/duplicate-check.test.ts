import { describe, expect, it } from "bun:test";
import type { TaskBoardItem } from "@/storage/types";
import { TASK_BOARD_ITEM_CREATE } from "./create";
import {
  acceptDuplicate,
  buildDuplicatePrompt,
  isOpenForDuplicateCheck,
  MAX_DUPLICATE_CANDIDATES,
  selectDuplicateCandidates,
  tokenize,
} from "./duplicate-check";

/**
 * The pure halves of the duplicate check: which cards reach the model, and
 * which of its answers are honored. The model call itself is exercised only
 * through the tool, never here (no mocks — see TESTING.md).
 */

let seq = 0;
function card(overrides: Partial<TaskBoardItem> = {}): TaskBoardItem {
  seq += 1;
  return {
    id: `tbi_${seq}`,
    organizationId: "org_1",
    title: `Card ${seq}`,
    description: null,
    status: "todo",
    priority: "none",
    type: "chore",
    assigneeId: null,
    assignedBy: null,
    repo: null,
    repositoryId: null,
    dueDate: null,
    sortOrder: seq,
    keySeq: seq,
    externalUrl: null,
    previewRoutes: [],
    source: null,
    retryAttempts: 0,
    reviewCycleStartedAt: null,
    threads: [],
    tags: [],
    reviewVerdicts: [],
    createdBy: "user_1",
    createdAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    updatedBy: "user_1",
    updatedAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    ...overrides,
  } as TaskBoardItem;
}

describe("tokenize", () => {
  it("lowercases, strips accents and stop words, drops short tokens", () => {
    expect(
      [...tokenize("Não abre o Modal de Configurações no iPhone")].sort(),
    ).toEqual(["abre", "configuracoes", "iphone", "modal"]);
  });

  it("ignores punctuation and keeps identifiers", () => {
    expect([...tokenize("fix: `useOrgFlag()` returns stale value!")]).toEqual([
      "fix",
      "useorgflag",
      "returns",
      "stale",
      "value",
    ]);
  });
});

describe("isOpenForDuplicateCheck", () => {
  it("excludes done and archived cards, keeps every other lane", () => {
    expect(isOpenForDuplicateCheck(card({ status: "done" }))).toBe(false);
    expect(isOpenForDuplicateCheck(card({ status: "archived" }))).toBe(false);
    for (const status of [
      "triage",
      "todo",
      "in_progress",
      "in_review",
      "approved",
      "merged",
      "post_deploy_validation",
    ] as const) {
      expect(isOpenForDuplicateCheck(card({ status }))).toBe(true);
    }
  });
});

describe("selectDuplicateCandidates", () => {
  it("drops finished cards even when they match word for word", () => {
    const done = card({ title: "Add dark mode toggle", status: "done" });
    const open = card({ title: "Add dark mode toggle", status: "todo" });
    const picked = selectDuplicateCandidates([done, open], {
      title: "Add dark mode toggle",
    });
    expect(picked.map((c) => c.id)).toEqual([open.id]);
  });

  it("ranks by word overlap, best match first", () => {
    const unrelated = card({ title: "Rotate the signing key" });
    const close = card({ title: "Dark mode toggle in settings" });
    const partial = card({ title: "Settings page redesign" });
    const picked = selectDuplicateCandidates([unrelated, partial, close], {
      title: "Add a dark mode toggle to settings",
    });
    expect(picked.map((c) => c.id)).toEqual([
      close.id,
      partial.id,
      unrelated.id,
    ]);
  });

  it("keeps every open card when under the cap, unrelated ones included", () => {
    const cards = [card({ title: "alpha" }), card({ title: "omega" })];
    expect(
      selectDuplicateCandidates(cards, { title: "something else" }),
    ).toHaveLength(2);
  });

  it("caps the list, keeping the best-matching and then the newest", () => {
    const filler = Array.from({ length: MAX_DUPLICATE_CANDIDATES }, () =>
      card({ title: "unrelated filler" }),
    );
    const newest = filler[filler.length - 1]!;
    const oldest = filler[0]!;
    const match = card({ title: "Checkout button is unclickable on Safari" });
    const picked = selectDuplicateCandidates([...filler, match], {
      title: "Checkout button unclickable on Safari",
    });
    expect(picked).toHaveLength(MAX_DUPLICATE_CANDIDATES);
    expect(picked[0]!.id).toBe(match.id);
    expect(picked.map((c) => c.id)).toContain(newest.id);
    expect(picked.map((c) => c.id)).not.toContain(oldest.id);
  });

  it("excludes cards naming a different repo, keeps repo-less ones", () => {
    const sameRepo = card({ title: "Fix login", repo: "acme/web" });
    const otherRepo = card({ title: "Fix login", repo: "acme/api" });
    const noRepo = card({ title: "Fix login" });
    const picked = selectDuplicateCandidates([sameRepo, otherRepo, noRepo], {
      title: "Fix login",
      repo: "ACME/Web",
    });
    expect(picked.map((c) => c.id).sort()).toEqual(
      [sameRepo.id, noRepo.id].sort(),
    );
  });

  it("with no repo on the draft, every open card is a candidate", () => {
    const a = card({ repo: "acme/web" });
    const b = card({ repo: "acme/api" });
    expect(
      selectDuplicateCandidates([a, b], { title: "anything" }),
    ).toHaveLength(2);
  });
});

describe("acceptDuplicate", () => {
  const offered = [card(), card()];

  it("honors a high-confidence match on an offered card", () => {
    expect(
      acceptDuplicate(
        { duplicateOf: offered[1]!.id, confidence: "high", reason: "same" },
        offered,
      ),
    ).toBe(offered[1]!);
  });

  it("rejects medium and low confidence", () => {
    for (const confidence of ["medium", "low"] as const) {
      expect(
        acceptDuplicate(
          { duplicateOf: offered[0]!.id, confidence, reason: "maybe" },
          offered,
        ),
      ).toBeNull();
    }
  });

  it("rejects an id that was not offered, so the model cannot point elsewhere", () => {
    expect(
      acceptDuplicate(
        { duplicateOf: "tbi_from_another_org", confidence: "high", reason: "" },
        offered,
      ),
    ).toBeNull();
  });

  it("treats a null id and a null verdict as no duplicate", () => {
    expect(
      acceptDuplicate(
        { duplicateOf: null, confidence: "high", reason: "none" },
        offered,
      ),
    ).toBeNull();
    expect(acceptDuplicate(null, offered)).toBeNull();
  });
});

describe("buildDuplicatePrompt", () => {
  it("lists every candidate by id with lane, repo and a one-line description", () => {
    const c = card({
      title: "Fix login",
      status: "in_progress",
      repo: "acme/web",
      description: "Users on\nSafari  cannot\tlog in.",
    });
    const prompt = buildDuplicatePrompt(
      { title: "Login broken", description: null, repo: "acme/web" },
      [c],
    );
    expect(prompt).toContain(
      `- [${c.id}] (in_progress, acme/web) Fix login — Users on Safari cannot log in.`,
    );
    expect(prompt).toContain("Title: Login broken");
    expect(prompt).toContain("Description: (none)");
  });

  it("truncates long descriptions so one verbose card cannot flood the prompt", () => {
    const c = card({ description: "x".repeat(2000) });
    const prompt = buildDuplicatePrompt({ title: "t" }, [c]);
    expect(prompt.length).toBeLessThan(600);
    expect(prompt).toContain("…");
  });
});

describe("TASK_BOARD_ITEM_CREATE onDuplicate", () => {
  it("is optional and accepts only the two modes", () => {
    expect(
      TASK_BOARD_ITEM_CREATE.inputSchema.safeParse({ title: "t" }).success,
    ).toBe(true);
    expect(
      TASK_BOARD_ITEM_CREATE.inputSchema.safeParse({
        title: "t",
        onDuplicate: "return_existing",
      }).success,
    ).toBe(true);
    expect(
      TASK_BOARD_ITEM_CREATE.inputSchema.safeParse({
        title: "t",
        onDuplicate: "reject",
      }).success,
    ).toBe(false);
  });

  it("output always carries the dedup verdict", () => {
    const shape = TASK_BOARD_ITEM_CREATE.outputSchema.shape;
    expect(Object.keys(shape).sort()).toEqual(
      ["deduplicated", "duplicateReason", "item"].sort(),
    );
  });
});
