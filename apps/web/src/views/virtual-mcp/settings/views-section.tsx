/**
 * The Views card on the settings index: every view this project can open, in
 * sidebar order, plus the two settings that say where it lands.
 *
 * One card, not one per source: a view from a connected app is the same kind of
 * thing as a native one, so the app's rows sit under a labelled divider inside
 * the same list instead of in a section of their own.
 *
 * State and writers come from `useProjectViews`, called once by the settings
 * view — this file only renders.
 */

import { IntegrationIcon } from "@/components/integration-icon.tsx";
import { toTitleCase } from "@/components/chat/message/parts/tool-call-part/utils";
import { useT } from "@/i18n/use-t.ts";
import { formatPinnedViewTabId } from "@/layouts/main-panel-tabs/tab-id";
import { Input } from "@decocms/ui/components/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ChevronRight, Lightning01 } from "@untitledui/icons";
import { SimpleIconPicker } from "@/components/simple-icon-picker";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { SidebarViewIcon, ViewRowActions } from "./view-row-actions";
import type { ProjectViews } from "./use-project-views";

/** Clicking a control inside a row must not also open the row's view. */
const stopRowClick = (event: { stopPropagation: () => void }) =>
  event.stopPropagation();

/** The row that names the app a group of views comes from. */
function AppHeaderRow({ icon, title }: { icon: string | null; title: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/30">
      <IntegrationIcon
        icon={icon}
        name={title}
        size="xs"
        className="shrink-0"
      />
      <span className="text-xs text-muted-foreground">{title}</span>
    </div>
  );
}

export function ProjectViewsSection({ views }: { views: ProjectViews }) {
  const t = useT();
  return (
    <SettingsSection title={t("virtualMcp.settings.views.projectViews")}>
      <SettingsCard>
        {views.projectViews.map((viewId) => {
          const pinned = views.pinned(viewId);
          return (
            <SettingsCardItem
              key={viewId}
              icon={<SidebarViewIcon viewId={viewId} />}
              title={views.labels[viewId]}
              onClick={() => views.openView(viewId)}
              action={
                <div className="flex items-center gap-1">
                  <ViewRowActions
                    pinned={pinned}
                    canSetMainView={pinned && !views.isMainView(viewId)}
                    onOpen={() => views.openView(viewId)}
                    onTogglePin={() => views.togglePin(viewId, !pinned)}
                    onSetMainView={() => views.setMainView(viewId)}
                  />
                  <span
                    onClick={() => views.openView(viewId)}
                    className="flex cursor-pointer items-center text-muted-foreground"
                  >
                    <ChevronRight size={16} />
                  </span>
                </div>
              }
            />
          );
        })}

        {/** App views, each group behind the divider that names its app. */}
        {views.connectionsData.flatMap((conn) => [
          <AppHeaderRow
            key={`${conn.id}:header`}
            icon={conn.icon}
            title={conn.title}
          />,
          ...conn.uiTools.map((tool) => {
            const pinnedView = views.pinnedAppViews.find(
              (v) => v.connectionId === conn.id && v.toolName === tool.name,
            );
            const pinned = !!pinnedView;
            const tabId = formatPinnedViewTabId(conn.id, tool.name);
            const mainViewValue = `ext-apps:${conn.id}:${tool.name}`;
            return (
              <SettingsCardItem
                key={`${conn.id}:${tool.name}`}
                onClick={() => views.openView(tabId)}
                icon={
                  pinned ? (
                    // A control, not the row: it must not also open.
                    <span onClick={stopRowClick}>
                      <SimpleIconPicker
                        value={pinnedView.icon ?? null}
                        onChange={(icon) =>
                          views.setAppViewIcon(conn.id, tool.name, icon)
                        }
                      />
                    </span>
                  ) : (
                    <Lightning01 size={16} />
                  )
                }
                title={
                  pinned ? (
                    <span onClick={stopRowClick}>
                      <Input
                        value={pinnedView.label}
                        onChange={(e) =>
                          views.setAppViewLabel(
                            conn.id,
                            tool.name,
                            e.target.value,
                          )
                        }
                        onBlur={views.commitAppViewLabel}
                        className="h-7 w-52 text-sm"
                      />
                    </span>
                  ) : (
                    (tool.title ?? toTitleCase(tool.name))
                  )
                }
                action={
                  <div className="flex items-center gap-1">
                    <ViewRowActions
                      pinned={pinned}
                      canSetMainView={
                        pinned && !views.isMainView(mainViewValue)
                      }
                      onOpen={() => views.openView(tabId)}
                      onTogglePin={() =>
                        views.toggleAppViewPin(conn.id, tool.name)
                      }
                      onSetMainView={() => views.setMainView(mainViewValue)}
                    />
                    <span
                      onClick={() => views.openView(tabId)}
                      className="flex cursor-pointer items-center text-muted-foreground"
                    >
                      <ChevronRight size={16} />
                    </span>
                  </div>
                }
              />
            );
          }),
        ])}

        <SettingsCardItem
          title={t("virtualMcp.layoutTabContent.mainView")}
          description={t("virtualMcp.layoutTabContent.mainViewDescription")}
          action={
            <Select
              value={views.defaultMainView}
              onValueChange={views.setMainView}
            >
              <SelectTrigger className="w-44 h-8 text-sm shrink-0">
                <SelectValue
                  placeholder={t("virtualMcp.layoutTabContent.noMainView")}
                />
              </SelectTrigger>
              <SelectContent>
                {views.defaultMainOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingsCardItem
          title={t("virtualMcp.layoutTabContent.showChat")}
          description={t("virtualMcp.layoutTabContent.showChatDescription")}
          action={
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <span className="shrink-0">
                  <Switch
                    checked={views.noMainView ? true : views.chatDefaultOpen}
                    disabled={views.noMainView}
                    onCheckedChange={views.setChatDefaultOpen}
                  />
                </span>
              </TooltipTrigger>
              {views.noMainView && (
                <TooltipContent side="top">
                  {t("virtualMcp.layoutTabContent.chatAlwaysShown")}
                </TooltipContent>
              )}
            </Tooltip>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
