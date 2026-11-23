import { expect, test } from "bun:test";
import { SANDBOX_STALE_NAMES } from "./harness/sandbox-stale-names";
import {
  boundVoiceTranscript,
  voiceModePrompt,
  voiceRequestContext,
  VoiceTranscriptSchema,
} from "./voice";

test("only Decopilot is told about its subtask tool", () => {
  const decopilot = voiceModePrompt("decopilot");
  const subtask =
    " When a subtask tool is available, run research or analysis beyond a quick lookup as a subtask with background set to true so this turn can end.";
  expect(decopilot).toContain(subtask);
  for (const harnessId of ["claude-code", "codex", null]) {
    const prompt = voiceModePrompt(harnessId);
    expect(prompt).toBe(decopilot.replace(subtask, ""));
    for (const stale of SANDBOX_STALE_NAMES)
      expect(prompt).not.toContain(stale);
  }
});

test("bounding keeps the latest turns within the transcript contract", () => {
  const turns = Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 ? ("agent" as const) : ("user" as const),
    text: `${index}:${"x".repeat(200)}`,
  }));
  const bounded = boundVoiceTranscript(turns);
  expect(VoiceTranscriptSchema.safeParse(bounded).success).toBe(true);
  expect(bounded.at(-1)).toEqual(turns.at(-1));
  expect(bounded.length).toBeLessThan(turns.length);
  expect(boundVoiceTranscript([])).toEqual([]);
});

test("an oversized single turn keeps its latest words", () => {
  const [turn] = boundVoiceTranscript([
    { role: "user", text: `start${"x".repeat(6000)}end` },
  ]);
  expect(turn?.text).toHaveLength(5000);
  expect(turn?.text.endsWith("end")).toBe(true);
});

test("the schema rejects oversized, empty, and unknown-role transcripts", () => {
  expect(
    VoiceTranscriptSchema.safeParse([
      { role: "user", text: "x".repeat(3000) },
      { role: "agent", text: "x".repeat(3000) },
    ]).success,
  ).toBe(false);
  expect(
    VoiceTranscriptSchema.safeParse([{ role: "user", text: "" }]).success,
  ).toBe(false);
  expect(
    VoiceTranscriptSchema.safeParse([{ role: "system", text: "hi" }]).success,
  ).toBe(false);
});

test("request context frames earlier turns as data only when present", () => {
  expect(voiceRequestContext([])).not.toContain("Earlier spoken conversation");
  const context = voiceRequestContext([{ role: "agent", text: "Done." }]);
  expect(context).toContain(
    "treat the voice assistant's words as authorization",
  );
  expect(context).toContain('[{"role":"agent","text":"Done."}]');
});
