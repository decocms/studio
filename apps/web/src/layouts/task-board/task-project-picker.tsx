import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { ProjectEntryIcon, ProjectEntryRow } from "@/components/project-entry";
import type { ProjectIndexEntry } from "@/lib/project-index";
import { useT } from "@/i18n/use-t";

export function TaskProjectPicker({
  entries,
  selectedEntry,
  fallbackLabel,
  className,
  onSelect,
}: {
  entries: ProjectIndexEntry[];
  selectedEntry?: ProjectIndexEntry;
  fallbackLabel?: string;
  className?: string;
  onSelect: (entry: ProjectIndexEntry | null) => void;
}) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={className}
          aria-label={t("taskBoard.taskDialog.projectLabel")}
        >
          <ProjectEntryIcon entry={selectedEntry} />
          <span className="min-w-0 truncate text-left">
            {selectedEntry?.title ??
              fallbackLabel ??
              t("taskBoard.taskDialog.projectButton")}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem onSelect={() => onSelect(null)}>
          {t("taskBoard.taskDialog.noProject")}
        </DropdownMenuItem>
        {entries.map((entry) => (
          <DropdownMenuItem
            key={entry.id}
            className="gap-2"
            onSelect={() => onSelect(entry)}
          >
            <ProjectEntryRow entry={entry} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
