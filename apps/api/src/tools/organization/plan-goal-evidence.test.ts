import { describe, expect, it } from "bun:test";
import { memoryTemplate } from "@decocms/shared/memory";
import {
  checkProposal,
  type Evidence,
  evidenceLabels,
  filesToRead,
  findQuote,
  isPersonWrittenText,
  isUnreadableDocument,
  isWrittenMemory,
  unreadDocuments,
  withinBudget,
} from "./plan-goal-evidence";

const entry = (
  path: string,
  overrides: Partial<{
    kind: "file" | "dir";
    threadId: string | null;
    deletedAt: string | null;
  }> = {},
) => ({
  path,
  kind: "file" as const,
  threadId: null,
  deletedAt: null,
  ...overrides,
});

describe("isPersonWrittenText", () => {
  it("reads text files a person wrote", () => {
    for (const path of [
      "okrs-2027.md",
      "docs/briefing.markdown",
      "notes/meeting.txt",
      "targets.csv",
      "goals.json",
    ]) {
      expect(isPersonWrittenText(entry(path))).toBe(true);
    }
  });

  it("skips what a chat or run wrote, and the folders that repeat the goal", () => {
    expect(isPersonWrittenText(entry("okrs.md", { threadId: "thrd_1" }))).toBe(
      false,
    );
    for (const path of [
      "plans/cases/search/case.md",
      "skills/brand/SKILL.md",
      "users/user_1/MEMORY.md",
      "MEMORY.md",
    ]) {
      expect(isPersonWrittenText(entry(path))).toBe(false);
    }
  });

  it("skips folders, deleted files and other extensions", () => {
    expect(isPersonWrittenText(entry("docs", { kind: "dir" }))).toBe(false);
    expect(
      isPersonWrittenText(entry("okrs.md", { deletedAt: "2026-01-01" })),
    ).toBe(false);
    expect(isPersonWrittenText(entry("deck.pdf"))).toBe(false);
    expect(isPersonWrittenText(entry("logo.png"))).toBe(false);
  });
});

describe("isUnreadableDocument", () => {
  it("names the person's documents the API cannot read", () => {
    for (const path of ["plano-2027.pdf", "okrs.docx", "deck.pptx", "x.xlsx"]) {
      expect(isUnreadableDocument(entry(path))).toBe(true);
    }
  });

  it("leaves out text, images and what an agent wrote", () => {
    expect(isUnreadableDocument(entry("okrs.md"))).toBe(false);
    expect(isUnreadableDocument(entry("logo.png"))).toBe(false);
    expect(
      isUnreadableDocument(entry("deck.pdf", { threadId: "thrd_1" })),
    ).toBe(false);
    expect(isUnreadableDocument(entry("plans/cases/a/deck.pdf"))).toBe(false);
  });
});

describe("findQuote", () => {
  const evidence: Evidence[] = [
    { kind: "memory", label: "MEMORY.md", text: "# Org memory\nNothing yet." },
    {
      kind: "connection",
      label: "Grain",
      text: 'CEO: "O foco de 2027 é   fazer o app\nvender mais que o site."',
    },
  ];

  it("finds the quote despite case, quote marks and spacing", () => {
    const found = findQuote(
      "o foco de 2027 é fazer o app vender mais que o site",
      evidence,
    );
    expect(found?.label).toBe("Grain");
    expect(
      findQuote(
        "“O foco de 2027 é fazer o app vender mais que o site.”",
        evidence,
      )?.kind,
    ).toBe("connection");
  });

  it("rejects a quote that is not in the evidence", () => {
    expect(
      findQuote("O foco de 2027 é parar de perder vendas por erros", evidence),
    ).toBeNull();
  });

  it("rejects fragments too short to prove anything", () => {
    expect(findQuote("o foco de 2027", evidence)).toBeNull();
    expect(findQuote("   ", evidence)).toBeNull();
  });
});

describe("filesToRead", () => {
  it("reads the newest person-written text files first, up to 20", () => {
    const entries = Array.from({ length: 25 }, (_, index) => ({
      ...entry(`notes/${index}.md`),
      updatedAt: `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    const picked = filesToRead([
      ...entries,
      { ...entry("plans/cases/a/case.md"), updatedAt: "2026-12-31T00:00:00Z" },
    ]);
    expect(picked).toHaveLength(20);
    expect(picked[0]?.path).toBe("notes/24.md");
    expect(picked.some((file) => file.path.startsWith("plans/"))).toBe(false);
  });
});

describe("unreadDocuments", () => {
  it("names at most ten documents", () => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      entry(`deck-${index}.pdf`),
    );
    expect(unreadDocuments(entries)).toHaveLength(10);
    expect(unreadDocuments([entry("okrs.md")])).toEqual([]);
  });
});

describe("isWrittenMemory", () => {
  it("ignores an empty memory and the seeded template", () => {
    expect(isWrittenMemory("")).toBe(false);
    expect(isWrittenMemory(`  ${memoryTemplate("organization")}\n`)).toBe(
      false,
    );
    expect(isWrittenMemory("# Org\nThe focus for 2027 is the app.")).toBe(true);
  });
});

describe("withinBudget", () => {
  const item = (label: string, text: string): Evidence => ({
    kind: "file",
    label,
    text,
  });

  it("caps each item, stops at the total and drops empty ones", () => {
    const kept = withinBudget(
      [item("a", "  aaaaaa  "), item("blank", "   "), item("b", "bbbbbb")],
      4,
      6,
    );
    expect(kept).toEqual([item("a", "aaaa"), item("b", "bb")]);
    expect(withinBudget([item("a", "aaaa"), item("b", "bb")], 10, 4)).toEqual([
      item("a", "aaaa"),
    ]);
  });
});

describe("evidenceLabels", () => {
  it("names each source once, in reading order", () => {
    expect(
      evidenceLabels([
        { kind: "memory", label: "MEMORY.md", text: "x" },
        { kind: "connection", label: "Grain", text: "y" },
        { kind: "connection", label: "Grain", text: "z" },
      ]),
    ).toEqual(["MEMORY.md", "Grain"]);
  });
});

describe("checkProposal", () => {
  const said =
    "Em 2027 o nosso foco é fazer o app vender mais que o site, disse a CEO.";
  const evidence: Evidence[] = [
    { kind: "file", label: "estrategia/2027.md", text: said },
  ];

  it("keeps a sentence whose quote was said, with where it was said", () => {
    const proposal = checkProposal(
      {
        statement: "  Fazer o app vender mais que o site em 2027. ",
        quote: "o nosso foco é fazer o app vender mais que o site",
      },
      evidence,
    );
    expect(proposal).toEqual({
      ok: true,
      statement: "Fazer o app vender mais que o site em 2027.",
      quote: "o nosso foco é fazer o app vender mais que o site",
      source: evidence[0]!,
    });
  });

  it("finds nothing without both a sentence and a quote", () => {
    for (const proposal of [
      { statement: null, quote: null },
      { statement: "Grow the app.", quote: null },
      { statement: "  ", quote: "o nosso foco é fazer o app vender mais" },
    ]) {
      expect(checkProposal(proposal, evidence)).toEqual({
        ok: false,
        reason: "not_found",
      });
    }
  });

  it("is not clear when nobody said the quote", () => {
    expect(
      checkProposal(
        {
          statement: "Stop losing sales to site errors.",
          quote: "Our focus is to stop losing sales to site errors",
        },
        evidence,
      ),
    ).toEqual({ ok: false, reason: "not_clear" });
  });
});
