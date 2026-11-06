import { Lock01 } from "@untitledui/icons";
import { branchUserLabel } from "@decocms/shared/branch-name";
import {
  useOptionalChatStream,
  useOptionalChatTask,
} from "@/components/chat/chat-context";
import { useStartDraft } from "@/components/thread/repository/use-start-draft";
import { useT } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client";
import { SiteDraftGuide } from "./site-draft-view";

/**
 * The site editor of a Fast Preview session on production (see
 * `resolveProductionGate`): nothing to edit, one way forward — a new draft,
 * opened the way the version switcher opens one.
 */
export function ProductionNotice({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const task = useOptionalChatTask();
  const stream = useOptionalChatStream();
  const { data: session } = authClient.useSession();
  const startDraft = useStartDraft({
    virtualMcpId,
    userLabel: branchUserLabel(session?.user),
    userId: session?.user?.id ?? "",
  });
  // A chat with messages keeps its branch: the draft opens in a new chat.
  const locked =
    (stream?.messages ?? []).length > 0 || (task?.isThreadLocked ?? false);
  const openDraft = () => {
    const branch = startDraft();
    if (!branch || !task) return;
    if (locked) task.createTask({ branch });
    else task.setCurrentTaskBranch(branch);
  };
  return (
    <SiteDraftGuide
      icon={<Lock01 />}
      title={t("siteEditor.productionLocked.title")}
      description={t("siteEditor.productionLocked.body")}
      action={{
        label: t("thread.branchPicker.newVersion"),
        onClick: openDraft,
      }}
    />
  );
}
