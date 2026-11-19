/**
 * The case tab beside the chat: the canvas of the case this chat is building.
 * Before the agent's first write it draws what the Plan page sent (the goal
 * and the request), so the person lands on a page that is already taking
 * shape.
 */

import { matchBusinessCasePath } from "@decocms/shared/business-case";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { useOptionalChatStream } from "@/components/chat/chat-context.tsx";
import { useOptionalChatTask } from "@/components/chat/context";
import { Page } from "@/components/page";
import { formatLibraryFileTabId } from "@/layouts/main-panel-tabs/tab-id";
import { usePanelNavigate } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { useT } from "@/i18n/use-t.ts";
import { BusinessCaseCanvas } from "./business-case-canvas.tsx";
import { readCaseSeed } from "./case-seed.ts";
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

/** Sends an open question to the chat this case belongs to, when that chat is
 *  the one beside the tab. */
function useAskInChat(path: string) {
  const t = useT();
  const chat = useOptionalChatStream();
  const task = useOptionalChatTask();
  const threadId = matchBusinessCasePath(path);
  if (!chat || !threadId || task?.taskId !== threadId || chat.isStreaming) {
    return undefined;
  }
  return (question: string) =>
    void chat.sendMessage({
      parts: [{ type: "text", text: t("plan.case.askPrompt", { question }) }],
    });
}

export function BusinessCaseTab({ path }: { path: string }) {
  const t = useT();
  const { openPanel } = usePanelNavigate();
  const read = useBusinessCase(path);
  const onAsk = useAskInChat(path);
  const value = read.data?.value ?? readCaseSeed(sessionStorage, path);

  return (
    <Page>
      <Page.Content>
        <Page.Container width="wide" className="py-8">
          {value ? (
            <BusinessCaseCanvas
              value={value}
              invalid={read.data?.invalid}
              onAsk={onAsk}
              onOpenDocument={(documentPath) =>
                openPanel(formatLibraryFileTabId(`home/${documentPath}`))
              }
            />
          ) : (
            <CaseLoading
              label={read.isPending ? undefined : t("plan.case.waiting")}
            />
          )}
        </Page.Container>
      </Page.Content>
    </Page>
  );
}
