import { virtualMcp } from "./virtual-mcp.ts";
import { user } from "./user.ts";
import { tools } from "./tools.ts";
import { thread } from "./thread.ts";
import { tasksPanel } from "./tasks-panel.ts";
import { taskBoard } from "./task-board.ts";
import { sidebar } from "./sidebar.ts";
import { sectionsEditor } from "./sections-editor.ts";
import { routes } from "./routes.ts";
import { reports } from "./reports.ts";
import { releaseChannel } from "./release-channel.ts";
import { registry } from "./registry.ts";
import { orgs } from "./orgs.ts";
import { monitoring } from "./monitoring.ts";
import { mainPanelTabs } from "./main-panel-tabs.ts";
import { library } from "./library.ts";
import { layouts } from "./layouts.ts";
import { home } from "./home.ts";
import { header } from "./header.ts";
import { filePicker } from "./file-picker.ts";
import { devAgent } from "./dev-agent.ts";
import { details } from "./details.ts";
import { deck } from "./deck.ts";
import { connections } from "./connections.ts";
import { common } from "./common.ts";
import { commerceOnboarding } from "./commerce-onboarding.ts";
import { collections } from "./collections.ts";
import { cmsTour } from "./cms-tour.ts";
import { chat } from "./chat.ts";
import { automations } from "./automations.ts";
import { agentShellLayout } from "./agent-shell-layout.ts";
import { admin } from "./admin.ts";
import { sandbox } from "./sandbox.ts";
import { settings } from "./settings.ts";
import { announcements } from "./announcements.ts";
import { paywall } from "./paywall.ts";

// English is the source of truth: every domain file is spread here and
// TranslationKey is derived from the result. pt-BR mirrors this structure
// and is type-checked against it, so `bun run check` proves completeness.
export const en = {
  ...virtualMcp,
  ...user,
  ...tools,
  ...thread,
  ...tasksPanel,
  ...taskBoard,
  ...sidebar,
  ...sectionsEditor,
  ...routes,
  ...reports,
  ...releaseChannel,
  ...registry,
  ...orgs,
  ...monitoring,
  ...mainPanelTabs,
  ...library,
  ...layouts,
  ...home,
  ...header,
  ...filePicker,
  ...devAgent,
  ...details,
  ...deck,
  ...connections,
  ...common,
  ...commerceOnboarding,
  ...collections,
  ...cmsTour,
  ...chat,
  ...automations,
  ...agentShellLayout,
  ...admin,
  ...sandbox,
  ...settings,
  ...announcements,
  ...paywall,
} as const;

export type TranslationKey = keyof typeof en;
