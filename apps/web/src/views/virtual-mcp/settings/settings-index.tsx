/**
 * The settings index: grouped rows that drill into one section each.
 *
 * Presentation only — every row's availability, summary and handler is decided
 * by the caller, which is the one place that has the project's data. Built on
 * the org settings kit (`components/settings/settings-section.tsx`) so project
 * settings and `/settings` are the same screen twice, not two designs.
 */

import { ChevronRight } from "@untitledui/icons";
import type { ReactNode } from "react";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsPage,
  SettingsSection,
} from "@/components/settings/settings-section";
import { cn } from "@decocms/ui/lib/utils.ts";

export interface ProjectSettingsRowDef {
  key: string;
  icon: ReactNode;
  title: string;
  description: string;
  /** The row's current answer, right-aligned: "3 connections", "Off". */
  value?: string;
  onClick: () => void;
  destructive?: boolean;
}

export interface ProjectSettingsGroupDef {
  key: string;
  /** Absent for the first card, which needs no heading to be understood. */
  title?: string;
  rows?: ProjectSettingsRowDef[];
  /** A group that renders its own lists instead of drill-in rows. */
  content?: ReactNode;
}

export function ProjectSettingsIndex({
  header,
  groups,
}: {
  header?: ReactNode;
  groups: ProjectSettingsGroupDef[];
}) {
  return (
    <SettingsPage>
      {header}
      {groups
        .filter((group) => group.content || group.rows?.length)
        .map((group) =>
          group.content ? (
            <div key={group.key}>{group.content}</div>
          ) : (
            <SettingsSection key={group.key} title={group.title}>
              <SettingsCard>
                {(group.rows ?? []).map((row) => (
                  <SettingsCardItem
                    key={row.key}
                    onClick={row.onClick}
                    icon={row.icon}
                    title={
                      <span
                        className={cn(row.destructive && "text-destructive")}
                      >
                        {row.title}
                      </span>
                    }
                    description={row.description}
                    action={
                      <div className="flex items-center gap-2 text-muted-foreground">
                        {/** The action slot stops propagation for the controls
                         *  inside it, so the row's own affordance re-arms it. */}
                        <span
                          onClick={row.onClick}
                          className="flex cursor-pointer items-center gap-2"
                        >
                          {row.value && (
                            <span className="text-sm">{row.value}</span>
                          )}
                          <ChevronRight size={16} />
                        </span>
                      </div>
                    }
                  />
                ))}
              </SettingsCard>
            </SettingsSection>
          ),
        )}
    </SettingsPage>
  );
}
