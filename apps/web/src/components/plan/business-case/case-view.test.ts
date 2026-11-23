import { describe, expect, it } from "bun:test";
import {
  emptyBusinessCase,
  type BusinessCase,
} from "@decocms/shared/business-case";
import type { ChatMessage, UserAskToolPart } from "@/components/chat/types";
import { caseView, userAskQuestion } from "./case-view.ts";

function aCase(
  status: BusinessCase["status"],
  filled: (keyof BusinessCase["cards"])[] = [],
): BusinessCase {
  const value = emptyBusinessCase({
    title: "Guia de medidas na PDP",
    objective: null,
    request: "guia de medidas",
  });
  for (const key of filled) {
    value.cards[key] = {
      state: "filled",
      summary: "ok",
      bullets: [],
      sources: [],
    };
  }
  return { ...value, status };
}

function ask(
  toolCallId: string,
  state: "input-available" | "output-available",
  input: Record<string, unknown> = { prompt: "Onde?", type: "text" },
) {
  return {
    type: "tool-user_ask",
    toolCallId,
    state,
    input,
    ...(state === "output-available" ? { output: { response: "PDP" } } : {}),
  };
}

function assistant(...parts: unknown[]): ChatMessage {
  return { id: "a", role: "assistant", parts } as unknown as ChatMessage;
}

const user = { id: "u", role: "user", parts: [] } as unknown as ChatMessage;

const base = {
  value: aCase("building", ["scope", "measurement"]),
  isCaseThread: true,
  messages: [user, assistant({ type: "text", text: "pesquisando" })],
  running: true,
};

describe("caseView", () => {
  it("shows the canvas once the case is ready, even mid-question", () => {
    expect(
      caseView({
        ...base,
        value: aCase("ready"),
        messages: [user, assistant(ask("c1", "input-available"))],
      }),
    ).toEqual({ kind: "canvas" });
  });

  it("shows the canvas when the open chat is not the case's chat", () => {
    expect(caseView({ ...base, isCaseThread: false })).toEqual({
      kind: "canvas",
    });
  });

  it("shows the first question the agent is waiting on", () => {
    const view = caseView({
      ...base,
      running: false,
      messages: [
        user,
        assistant(
          ask("done", "output-available"),
          ask("c1", "input-available"),
          ask("c2", "input-available"),
        ),
      ],
    });
    expect(view.kind === "question" && view.part.toolCallId).toBe("c1");
  });

  it("ignores a question from an earlier turn", () => {
    expect(
      caseView({
        ...base,
        messages: [assistant(ask("old", "input-available")), user],
      }),
    ).toEqual({ kind: "building", filled: 2 });
  });

  it("shows the cards filling in while the agent works", () => {
    expect(
      caseView({
        ...base,
        messages: [user, assistant(ask("c1", "output-available"))],
      }),
    ).toEqual({ kind: "building", filled: 2 });
  });

  it("treats a case still framing like one being built", () => {
    expect(caseView({ ...base, value: aCase("framing") })).toEqual({
      kind: "building",
      filled: 0,
    });
  });

  it("waits for a chat whose first turn has not arrived yet", () => {
    expect(caseView({ ...base, messages: [], running: false })).toEqual({
      kind: "building",
      filled: 2,
    });
  });

  it("shows the canvas when the chat stopped before the case was ready", () => {
    expect(caseView({ ...base, running: false })).toEqual({ kind: "canvas" });
  });
});

describe("userAskQuestion", () => {
  const labels = { yes: "Sim", no: "Não" };
  const part = (input: Record<string, unknown>) =>
    ask("c1", "input-available", input) as unknown as UserAskToolPart;

  it("keeps a choice's options, trimmed, without blanks or repeats", () => {
    expect(
      userAskQuestion(
        part({
          prompt: "Onde fica o guia?",
          type: "choice",
          options: [" Ao lado do tamanho ", "", "Na foto", "Na foto"],
        }),
        labels,
      ),
    ).toEqual({
      text: "Onde fica o guia?",
      options: ["Ao lado do tamanho", "Na foto"],
    });
  });

  it("offers yes and no for a confirm", () => {
    expect(
      userAskQuestion(part({ prompt: "Mobile?", type: "confirm" }), labels),
    ).toEqual({ text: "Mobile?", options: ["Sim", "Não"] });
  });

  it("has no options for free text", () => {
    expect(
      userAskQuestion(part({ prompt: "Qual página?", type: "text" }), labels),
    ).toEqual({ text: "Qual página?", options: [] });
  });
});
