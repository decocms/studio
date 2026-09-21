import { page } from "./page";
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
import { orgs } from "./orgs.ts";
import { monitoring } from "./monitoring.ts";
import { mainPanelTabs } from "./main-panel-tabs.ts";
import { markdownEditor } from "./markdown-editor.ts";
import { library } from "./library.ts";
import { layouts } from "./layouts.ts";
import { layoutTour } from "./layout-tour.ts";
import { imageUpload } from "./image-upload.ts";
import { home } from "./home.ts";
import { header } from "./header.ts";
import { filePicker } from "./file-picker.ts";
import { devAgent } from "./dev-agent.ts";
import { downloadApp } from "./download-app.ts";
import { details } from "./details.ts";
import { deck } from "./deck.ts";
import { discover } from "./discover.ts";
import { commandPalette } from "./command-palette.ts";
import { connections } from "./connections.ts";
import { experiments } from "./experiments.ts";
import { common } from "./common.ts";
import { reportsOnboarding } from "./reports-onboarding.ts";
import { collections } from "./collections.ts";
import { chooseEditor } from "./choose-editor.ts";
import { chat } from "./chat.ts";
import { credits } from "./credits.ts";
import { automations } from "./automations.ts";
import { agentShellLayout } from "./agent-shell-layout.ts";
import { admin } from "./admin.ts";
import { sandbox } from "./sandbox.ts";
import { settings } from "./settings.ts";
import { announcements } from "./announcements.ts";
import { assets } from "./assets.ts";
import type { TranslationKey } from "../en/index.ts";

export const ptBR = {
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
  ...orgs,
  ...monitoring,
  ...mainPanelTabs,
  ...experiments,
  ...markdownEditor,
  ...library,
  ...layouts,
  ...layoutTour,
  ...imageUpload,
  ...home,
  ...header,
  ...filePicker,
  ...devAgent,
  ...downloadApp,
  ...details,
  ...deck,
  ...discover,
  ...commandPalette,
  ...connections,
  ...common,
  ...reportsOnboarding,
  ...collections,
  ...chooseEditor,
  ...chat,
  ...credits,
  ...automations,
  ...agentShellLayout,
  ...admin,
  ...sandbox,
  ...settings,
  ...announcements,
  ...assets,
  ...page,
} satisfies Record<TranslationKey, string>;
