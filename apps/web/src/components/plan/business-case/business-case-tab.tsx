/** The case tab beside the chat; `caseView` picks what it shows. */

import { useState } from "react";
import { toast } from "sonner";
import { matchBusinessCasePath } from "@decocms/shared/business-case";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { useOptionalChatStream } from "@/components/chat/chat-context.tsx";
import { useChatStream, useOptionalChatTask } from "@/components/chat/context";
import { useChatRequestOptions } from "@/components/chat/highlight/use-chat-request-options";
import type { UserAskToolPart } from "@/components/chat/types";
import { Page } from "@/components/page";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { openAnswersPrompt } from "../business-case-prompt.ts";
import { BUILDING, Question, Thinking } from "../guide/guide-screens.tsx";
import { BusinessCaseCanvas } from "./business-case-canvas.tsx";
import { readCaseSeed } from "./case-seed.ts";
import { caseView, userAskQuestion } from "./case-view.ts";
import { OpenQuestionsFlow } from "./open-questions-flow.tsx";
import { useBusinessCase } from "./use-business-case.ts";

function CaseLoading({ label }: { label?: string }) {
  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-10">
      <Skeleton className="h-56 rounded-2xl" />
      <div className="flex flex-col gap-8 pl-10">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      {label && <p className="text-xs text-muted-foreground">{label}</p>}
    </div>
  );
}

/** Sends a message to the chat this case belongs to, when that chat is the
 *  one beside the tab and free to take it. */
function useCaseChat(path: string) {
  const chat = useOptionalChatStream();
  const task = useOptionalChatTask();
  const threadId = matchBusinessCasePath(path);
  if (!chat || !threadId || task?.taskId !== threadId || chat.isStreaming) {
    return undefined;
  }
  return (text: string) =>
    void chat.sendMessage({ parts: [{ type: "text", text }] });
}

/** The agent's pending question on the guided intro's screen; the answer
 *  goes to the chat the way the chat's own question form sends it. */
function CaseQuestion({ part }: { part: UserAskToolPart }) {
  const t = useT();
  const { submit } = useChatStream();
  const requestOptions = useChatRequestOptions();
  const labels = {
    yes: t("chat.userAskQuestion.confirmYes"),
    no: t("chat.userAskQuestion.confirmNo"),
  };
  const answer = (text: string) => {
    const confirm = part.input?.type === "confirm";
    const response = !text.trim()
      ? t("chat.userAskQuestion.skipMessage")
      : confirm && text === labels.yes
        ? "yes"
        : confirm && text === labels.no
          ? "no"
          : text.trim();
    void submit(
      { kind: "toolOutput", toolCallId: part.toolCallId, output: { response } },
      requestOptions(),
    );
  };
  return (
    <Question
      view={{ question: userAskQuestion(part, labels), reaction: null }}
      onAnswer={answer}
    />
  );
}

export function BusinessCaseTab({ path }: { path: string }) {
  const t = useT();
  const chat = useOptionalChatStream();
  const task = useOptionalChatTask();
  const read = useBusinessCase(path);
  const send = useCaseChat(path);
  /** The open questions being answered, as they were when the flow opened. */
  const [answering, setAnswering] = useState<string[] | null>(null);
  const value = read.data?.value ?? readCaseSeed(sessionStorage, path);

  if (!value) {
    return (
      <Page>
        <Page.Content>
          <Page.Container width="wide" className="py-8">
            <CaseLoading
              label={read.isPending ? undefined : t("plan.case.waiting")}
            />
          </Page.Container>
        </Page.Content>
      </Page>
    );
  }

  const view = caseView({
    value,
    isCaseThread:
      !!chat && !!task?.taskId && task.taskId === matchBusinessCasePath(path),
    messages: chat?.messages ?? [],
    running: !!chat?.isStreaming || task?.activeTask?.status === "in_progress",
  });

  // Ahead of the view: the agent may reopen the case before the last beat ends.
  if (answering) {
    return (
      <Page>
        <OpenQuestionsFlow
          title={value.title}
          questions={answering}
          onDone={(answers) => {
            track("plan_case_open_questions_answered", {
              questions: answers.length,
              skipped: answers.filter((a) => !a.answer.trim()).length,
            });
            // The chat may have got busy while the person was answering.
            if (send) send(openAnswersPrompt(t, answers));
            else toast.error(t("plan.case.openFlow.busy"));
          }}
          onClose={() => setAnswering(null)}
        />
      </Page>
    );
  }

  if (view.kind === "canvas") {
    return (
      <Page>
        <Page.Content>
          <Page.Container width="wide" className="py-8">
            <BusinessCaseCanvas
              value={value}
              invalid={read.data?.invalid}
              onAsk={
                send &&
                ((question) => send(t("plan.case.askPrompt", { question })))
              }
              onAnswerOpen={
                send &&
                ((questions) => {
                  track("plan_case_open_questions_opened", {
                    questions: questions.length,
                  });
                  setAnswering(questions);
                })
              }
            />
          </Page.Container>
        </Page.Content>
      </Page>
    );
  }

  return (
    <Page>
      <div className="flex h-full min-h-0 flex-col animate-in fade-in-0 duration-300 motion-reduce:animate-none">
        <div className="flex items-center gap-3 px-4 pt-4 md:px-8">
          <p className="min-w-0 truncate py-1.5 text-sm text-muted-foreground">
            <span className="text-meta mr-2">{t("page.businessCase")}</span>
            {value.title}
          </p>
        </div>
        <div className="flex min-h-0 flex-1 overflow-auto">
          <div className="m-auto flex w-full max-w-2xl justify-center px-4 py-10 md:px-8">
            {view.kind === "question" ? (
              <CaseQuestion key={view.part.toolCallId} part={view.part} />
            ) : (
              <Thinking
                phrases={BUILDING}
                offset={0}
                building
                filled={view.filled}
              />
            )}
          </div>
        </div>
      </div>
    </Page>
  );
}
