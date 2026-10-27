import {
  SplitButton,
  type SplitButtonMenuItem,
} from "@decocms/ui/components/split-button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import type { TFunction } from "@/i18n/use-t";
import { GitHubIcon } from "@/components/icons/github-icon.tsx";
import {
  AlertTriangle,
  CheckCircle,
  Eye,
  GitMerge,
  GitPullRequest,
  MessageCircle01,
  RefreshCw01,
  Rocket02,
} from "@untitledui/icons";
import type { HeaderAction, HeaderButton } from "./panel-state.ts";

/** Leading icon per action, for the primary half and the dropdown items. */
function actionIcon(action: HeaderAction): React.ReactNode {
  switch (action) {
    case "publish":
      return <Rocket02 className="size-4" />;
    case "create-pr":
    case "reopen":
      return <GitPullRequest className="size-4" />;
    case "rebase":
    case "sync":
      return <RefreshCw01 className="size-4" />;
    case "fix-checks":
      return <AlertTriangle className="size-4" />;
    case "mark-ready":
      return <CheckCircle className="size-4" />;
    case "resolve-comments":
      return <MessageCircle01 className="size-4" />;
    case "merge":
      return <GitMerge className="size-4" />;
    case "review":
      return <Eye className="size-4" />;
    case "open-pr-page":
      return <GitHubIcon size={16} />;
  }
}

/** Actions that resolve to a chat prompt, so they must wait for the current stream. */
const CHAT_ACTIONS = new Set<HeaderAction>([
  "reopen",
  "rebase",
  "fix-checks",
  "mark-ready",
  "resolve-comments",
  "review",
  "sync",
]);

/** Actions that act on the branch head, which an in-flight autosave is about to move. */
const HEAD_ACTIONS = new Set<HeaderAction>(["publish", "create-pr"]);

export function HeaderButtonRenderer(props: {
  t: TFunction;
  button: HeaderButton;
  actionBusy: boolean;
  changeRequestPending: boolean;
  savePending: boolean;
  onAction: (action: HeaderAction) => void;
}) {
  const { t, button, actionBusy, changeRequestPending, savePending, onAction } =
    props;
  const action = button.action;

  const chatBlocksAction =
    actionBusy && action !== undefined && CHAT_ACTIONS.has(action);
  const mergePending = changeRequestPending && action === "merge";
  const savingBlocksAction =
    savePending && action !== undefined && HEAD_ACTIONS.has(action);
  const disabled =
    Boolean(button.disabled) ||
    chatBlocksAction ||
    mergePending ||
    savingBlocksAction ||
    !action;
  const loading = Boolean(button.loading) || mergePending;
  const tooltip = chatBlocksAction
    ? t("thread.headerActions.chatIsRunning")
    : savingBlocksAction
      ? t("thread.headerActions.saving")
      : button.tooltip;

  const items: SplitButtonMenuItem[] = button.menu.map((item) => {
    const itemChatBlocked = actionBusy && CHAT_ACTIONS.has(item.action);
    const itemHeadBlocked = savePending && HEAD_ACTIONS.has(item.action);
    const itemMergeBlocked = item.action === "merge" && changeRequestPending;
    const itemTooltip = itemHeadBlocked
      ? t("thread.headerActions.saving")
      : itemChatBlocked
        ? t("thread.headerActions.chatIsRunning")
        : item.tooltip;
    return {
      key: item.key,
      label: item.label,
      icon: actionIcon(item.action),
      disabled: Boolean(itemChatBlocked || itemHeadBlocked || itemMergeBlocked),
      ...(itemTooltip ? { tooltip: itemTooltip } : {}),
      onSelect: () => onAction(item.action),
    };
  });

  return (
    <SplitButton
      size="sm"
      label={button.label}
      variant={button.variant}
      disabled={disabled}
      loading={loading}
      {...(action && !loading ? { icon: actionIcon(action) } : {})}
      {...(tooltip ? { tooltip } : {})}
      items={items}
      menuAriaLabel={t("thread.headerActions.moreActionsAriaLabel")}
      onClick={action ? () => onAction(action) : undefined}
    />
  );
}

export function WithTooltip({
  label,
  children,
}: {
  label: string | null;
  children: React.ReactNode;
}) {
  if (!label) return <>{children}</>;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>{children}</span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
