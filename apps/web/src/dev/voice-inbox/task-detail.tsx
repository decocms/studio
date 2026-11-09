import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { PERSON } from "./data";
import { TaskBoardItemDetail } from "@/layouts/task-board/task-dialog";
import type { TaskBoardItem } from "@/layouts/task-board/config";
import type { MockTask } from "./data";

export function MockTaskDetail({
  task,
  personName,
  projectControl,
  headerActions,
  onClose,
  onChange,
}: {
  task: MockTask;
  personName: string;
  projectControl: ReactNode;
  headerActions?: ReactNode;
  onClose: () => void;
  onChange: (item: TaskBoardItem) => void;
}) {
  const client = useQueryClient();
  const { locator } = useProjectContext();
  if (!client.getQueryData(KEYS.members(locator)))
    client.setQueryData(KEYS.members(locator), {
      data: {
        members: [
          {
            ...PERSON,
            id: PERSON.userId,
            user: { id: PERSON.userId, name: personName },
          },
        ],
      },
    });
  return (
    <TaskBoardItemDetail
      embedded
      hideComposer
      key={task.item.id}
      item={task.item}
      projectControl={projectControl}
      headerActions={headerActions}
      onClose={onClose}
      onSubmit={(input) => onChange({ ...task.item, ...input })}
    />
  );
}
