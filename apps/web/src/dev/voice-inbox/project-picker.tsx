import { TaskProjectPicker } from "@/layouts/task-board/task-project-picker";
import type { ProjectIndexEntry } from "@/lib/project-index";

export function MockProjectPicker({
  label,
  labels,
  onChange,
}: {
  label?: string;
  labels: string[];
  onChange: (label: string | undefined) => void;
}) {
  const entries: ProjectIndexEntry[] = [...new Set(labels)].map((title) => ({
    id: title,
    title,
    kind: "project",
    repo: null,
    projects: [],
  }));
  return (
    <TaskProjectPicker
      entries={entries}
      selectedEntry={entries.find((entry) => entry.title === label)}
      onSelect={(entry) => onChange(entry?.title)}
      className="inline-flex h-9 min-w-0 max-w-full items-center gap-2 rounded-lg px-2 text-sm hover:bg-accent"
    />
  );
}
