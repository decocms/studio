/** The Overview's first line: the chat's composer, pared down, to ask the agent about the data. */

import { type FormEvent, useState } from "react";
import {
  Activity,
  ArrowUp,
  BarChart01,
  Microphone01,
  SearchMd,
} from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useOptionalChatPrefs } from "@/components/chat/context";
import { TierTrigger } from "@/components/chat/tier-trigger";
import { useAskInChat } from "@/hooks/use-ask-in-chat";
import { useVoiceInput } from "@/hooks/use-voice-input.ts";
import { useT } from "@/i18n/use-t.ts";

/** Words said so far after what was typed, one space apart. */
function joined(...parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ");
}

export function AskData({ project }: { project: string | null }) {
  const t = useT();
  const ask = useAskInChat();
  const prefs = useOptionalChatPrefs();
  const voice = useVoiceInput();
  const [text, setText] = useState("");
  // What was typed when dictation started; the words said go after it.
  const [typed, setTyped] = useState("");
  const recording = voice.status === "recording";
  const shown = recording
    ? joined(typed, voice.transcript, voice.interimTranscript)
    : text;
  const ready = shown.trim().length > 0;

  const suggestions = [
    { icon: Activity, text: t("monitor.ask.suggestion.today") },
    { icon: BarChart01, text: t("monitor.ask.suggestion.pages") },
    { icon: SearchMd, text: t("monitor.ask.suggestion.errors") },
  ];

  const send = (question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    ask(trimmed);
    setText("");
  };
  const finishDictation = () => {
    const said = joined(typed, voice.stopRecording());
    setText(said);
    return said;
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(recording ? finishDictation() : text);
  };
  const onMic = () => {
    if (recording) {
      finishDictation();
      return;
    }
    setTyped(text);
    void voice.startRecording();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        {/* The brand's purple, lime and yellow, blurred into a glow under the bar. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-10 top-1/2 -bottom-2 rounded-full bg-gradient-to-r from-brand-purple via-brand to-brand-yellow opacity-40 blur-xl dark:opacity-25"
        />
        <form
          onSubmit={onSubmit}
          className="@container/chat-bottom focus-within-ring relative flex items-center gap-1.5 rounded-2xl bg-card p-2.5 pl-[18px] shadow-edge dark:bg-muted"
        >
          <input
            value={shown}
            onChange={(e) => setText(e.target.value)}
            readOnly={recording}
            placeholder={
              project
                ? t("monitor.ask.placeholderProject", { project })
                : t("monitor.ask.placeholder")
            }
            aria-label={t("monitor.ask.label")}
            className="h-8 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/50"
          />
          {prefs && <TierTrigger />}
          {voice.isSupported && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-pressed={recording}
              onClick={onMic}
              title={
                recording
                  ? t("monitor.ask.stopDictating")
                  : t("monitor.ask.dictate")
              }
              aria-label={
                recording
                  ? t("monitor.ask.stopDictating")
                  : t("monitor.ask.dictate")
              }
              className={cn(
                "text-muted-foreground hover:text-foreground",
                recording &&
                  "bg-destructive/10 text-destructive hover:text-destructive",
              )}
            >
              <Microphone01 size={18} />
            </Button>
          )}
          <Button
            type="submit"
            size="icon"
            variant={ready ? "default" : "ghost"}
            disabled={!ready}
            aria-label={t("monitor.ask.send")}
            title={t("monitor.ask.send")}
            className={cn(
              "size-8 shrink-0",
              !ready && "bg-muted text-muted-foreground disabled:opacity-100",
            )}
          >
            <ArrowUp size={20} />
          </Button>
        </form>
      </div>
      <ul className="flex flex-col">
        {suggestions.map(({ icon: Icon, text: question }) => (
          <li key={question}>
            <button
              type="button"
              onClick={() => send(question)}
              className="focus-ring flex w-full cursor-pointer items-center gap-3 rounded-xl px-[18px] py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Icon size={16} className="shrink-0" />
              {question}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
