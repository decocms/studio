/** The case tab beside the chat; `caseView` picks what it shows. */

import { matchBusinessCasePath } from "@decocms/shared/business-case";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { useChatStream, useChatTask } from "@/components/chat/context";
import { useChatRequestOptions } from "@/components/chat/highlight/use-chat-request-options";
import type { UserAskToolPart } from "@/components/chat/types";
import { Page } from "@/components/page";
import { formatLibraryFileTabId } from "@/layouts/main-panel-tabs/tab-id";
import { usePanelNavigate } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { useT } from "@/i18n/use-t.ts";
import { BUILDING, Question, Thinking } from "../guide/guide-screens.tsx";
import { BusinessCaseCanvas } from "./business-case-canvas.tsx";
import { readCaseSeed } from "./case-seed.ts";
import { caseView, userAskQuestion } from "./case-view.ts";
import { useBusinessCase } from "./use-business-case.ts";

function CaseLoading({ label }: { label?: string }) {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-2/3" />
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-40" />
        ))}
      </div>
      {label && <p className="text-xs text-muted-foreground">{label}</p>}
    </div>
  );
}

export function BusinessCaseTab({ path }: { path: string }) {
  const t = useT();
  const { openPanel } = usePanelNavigate();
  const { taskId, activeTask } = useChatTask();
  const { messages, isStreaming, submit } = useChatStream();
  const requestOptions = useChatRequestOptions();
  const read = useBusinessCase(path);
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
    isCaseThread: taskId !== null && taskId === matchBusinessCasePath(path),
    messages,
    running: isStreaming || activeTask?.status === "in_progress",
  });

  if (view.kind === "canvas") {
    return (
      <Page>
        <Page.Content>
          <Page.Container width="wide" className="py-8">
            <BusinessCaseCanvas
              value={value}
              invalid={read.data?.invalid}
              onOpenDocument={(documentPath) =>
                openPanel(formatLibraryFileTabId(`home/${documentPath}`))
              }
            />
          </Page.Container>
        </Page.Content>
      </Page>
    );
  }

  const labels = {
    yes: t("chat.userAskQuestion.confirmYes"),
    no: t("chat.userAskQuestion.confirmNo"),
  };
  /** The chat's own answer for a confirm, the skip message for an empty one. */
  const answer = (part: UserAskToolPart, text: string) => {
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
              <Question
                key={view.part.toolCallId}
                view={{
                  question: userAskQuestion(view.part, labels),
                  reaction: null,
                }}
                onAnswer={(text) => answer(view.part, text)}
              />
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
